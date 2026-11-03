import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiUpload, workspaceWikiUpload } from '../src/shared/operations/wiki/index.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function chunked(chunks: Uint8Array[]) {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls === chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[pulls++]);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

for (const definition of [orgWikiUpload, workspaceWikiUpload]) {
  function valid(target: Target, body = '本文') {
    return {
      ...('workspace' in definition ? { workspace_id: target.workspace.id } : {}),
      files: [{ file_name: '架空の手順.md', body_md: body }],
    };
  }
  async function rate(target: Target, prefix: 'request' | 'operation') {
    const db = commonDb(env);
    return db.first(
      db.statement((q) =>
        q
          .selectFrom('rate_limits')
          .select('count')
          .where('key', '=', `${prefix}:${definition.name}:${target.member.accountId}`),
      ),
    );
  }
  async function seedRate(target: Target, prefix: 'request' | 'operation', count: number) {
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.insertInto('rate_limits').values({
          key: `${prefix}:${definition.name}:${target.member.accountId}`,
          count,
          window_start_at: new Date().toISOString(),
        }),
      ),
    ]);
  }
  function send(target: Target, stream: ReadableStream<Uint8Array>) {
    return post(app, definition, { slug: target.slug, token: target.member.token, rawBody: stream });
  }

  describe(`${definition.name}: 要求枠とUTF-8ストリームを崩す検査`, () => {
    test('BOMと多バイト文字を1バイトずつ分けても本文を失わず保存する', async () => {
      const target = await createTarget();
      const source = '\uFEFF前書き😀\r\n本文𠮷';
      const bytes = new TextEncoder().encode('\uFEFF' + JSON.stringify(valid(target, source)));
      const body = chunked(Array.from(bytes, (byte) => new Uint8Array([byte])));
      const response = await send(target, body.stream);
      expect(response.status).toBe(200);
      expect(body.cancelled()).toBe(false);
      expect(body.pulls()).toBe(bytes.length);
      const { pages } = (await response.json()) as { pages: { id: string }[] };
      const db = orgDb(env, target.organization.verified);
      const page = await db.first(
        db.statement((q) => {
          const query = q.selectFrom('wiki_pages').select('body_md').where('id', '=', pages[0].id);
          return 'workspace' in definition
            ? query.where('workspace_id', '=', target.workspace.id)
            : query.where('organization_id', '=', target.organization.id);
        }),
      );
      expect(page?.body_md).toBe(source);
      expect(await rate(target, 'request')).toEqual({ count: 1 });
      expect(await rate(target, 'operation')).toEqual({ count: 1 });
    });

    test('有効なJSONの後でも不完全なUTF-8がEOFに残ればflushで拒否する', async () => {
      const target = await createTarget();
      const body = chunked([
        new TextEncoder().encode(JSON.stringify(valid(target))),
        new Uint8Array([0xf0]),
        new Uint8Array([0x9f, 0x98]),
      ]);
      const response = await send(target, body.stream);
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(body.pulls()).toBe(3);
      expect(await rate(target, 'request')).toEqual({ count: 1 });
      expect(await rate(target, 'operation')).toBeUndefined();
    });

    test('不正な継続バイトを受けた時点でcancelし、後続の本文を読まない', async () => {
      const target = await createTarget();
      const body = chunked([
        new TextEncoder().encode('{"files":[{"file_name":"架空.md","body_md":"'),
        new Uint8Array([0xe3]),
        new Uint8Array([0x28]),
        new TextEncoder().encode('残りの本文"}]}'),
      ]);
      const response = await send(target, body.stream);
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(body.cancelled()).toBe(true);
      expect(body.pulls()).toBe(3);
      expect(await rate(target, 'request')).toEqual({ count: 1 });
      expect(await rate(target, 'operation')).toBeUndefined();
    });

    test('要求枠の残り1回へ同時に3要求が来ても、本文を読むのは1要求だけ', async () => {
      const target = await createTarget();
      await seedRate(target, 'request', 59);
      const probes = Array.from({ length: 3 }, () => chunked([new TextEncoder().encode('{broken')]));
      const responses = await Promise.all(probes.map((probe) => send(target, probe.stream)));
      expect(responses.map((response) => response.status).sort()).toEqual([400, 429, 429]);
      expect(probes.map((probe) => probe.pulls()).sort()).toEqual([0, 0, 1]);
      expect(await rate(target, 'request')).toEqual({ count: 62 });
      expect(await rate(target, 'operation')).toBeUndefined();
    });

    test('ファイル件数枠の拒否でも要求を1回と数え、後続の不正JSONは別に検証する', async () => {
      const target = await createTarget();
      await seedRate(target, 'operation', 30);
      const body = chunked([new TextEncoder().encode(JSON.stringify(valid(target)))]);
      const response = await send(target, body.stream);
      expect(response.status).toBe(429);
      expect(body.pulls()).toBe(1);
      expect(await rate(target, 'request')).toEqual({ count: 1 });
      expect(await rate(target, 'operation')).toEqual({ count: 31 });
      const malformed = chunked([new TextEncoder().encode('{broken')]);
      const next = await send(target, malformed.stream);
      expect(next.status).toBe(400);
      expect(malformed.pulls()).toBe(1);
      expect(await rate(target, 'request')).toEqual({ count: 2 });
      expect(await rate(target, 'operation')).toEqual({ count: 31 });
    });
  });
}
