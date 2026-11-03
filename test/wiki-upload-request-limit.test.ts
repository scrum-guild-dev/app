import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiUpload, workspaceWikiUpload } from '../src/shared/operations/wiki/index.ts';
import { AT } from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// pull の自動先読みを止め、登録の関数が実際に本文を要求した場合だけ数える。
function bodyProbe(body = '{broken') {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls };
}

async function rateRows() {
  const db = commonDb(env);
  return db.rows(db.statement((q) => q.selectFrom('rate_limits').selectAll().orderBy('key')));
}

async function fileCount(target: Target, operation: string) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('rate_limits')
        .select('count')
        .where('key', '=', `operation:${operation}:${target.member.accountId}`),
    ),
  );
}

for (const definition of [orgWikiUpload, workspaceWikiUpload]) {
  function invalid(target: Target, stream: ReadableStream<Uint8Array>) {
    return post(app, definition, { slug: target.slug, token: target.member.token, rawBody: stream });
  }
  async function fillRequestWindow(target: Target) {
    for (let index = 0; index < 60; index++) {
      const body = bodyProbe();
      const response = await invalid(target, body.stream);
      expect(response.status, `${index + 1}回目の不正な要求は検証まで進む`).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(body.pulls()).toBe(1);
    }
  }

  describe(`${definition.name}: 本文を読む前の要求数の制限`, () => {
    test('不正入力も1分60要求に数え、61回目以降は本文を消費せず429にする', async () => {
      const target = await createTarget();
      await fillRequestWindow(target);
      // 不正入力は、別に存在する検証後のファイル件数枠を使わない。
      expect(await fileCount(target, definition.name)).toBeUndefined();
      for (const source of [
        '{broken',
        JSON.stringify({ workspace_id: target.workspace.id, files: [{ file_name: '手順.md', body_md: '本文' }] }),
      ]) {
        const body = bodyProbe(source);
        const response = await invalid(target, body.stream);
        expect(response.status).toBe(429);
        expect(await errorCodeOf(response)).toBe('rate_limited');
        expect(body.pulls()).toBe(0);
      }
      expect(await fileCount(target, definition.name)).toBeUndefined();
    });

    test('要求枠の窓が切れたら再び本文を読み、入力の検証へ進む', async () => {
      const target = await createTarget();
      const beforeKeys = new Set((await rateRows()).map((row) => row.key));
      await fillRequestWindow(target);
      const blocked = bodyProbe();
      expect((await invalid(target, blocked.stream)).status).toBe(429);
      expect(blocked.pulls()).toBe(0);
      // 新しい要求枠のキー表記には依存せず、この呼び出し群が作った行を特定する。
      const created = (await rateRows()).filter((row) => !beforeKeys.has(row.key));
      expect(created).toHaveLength(1);
      const db = commonDb(env);
      await db.run(
        db.statement((q) =>
          q.updateTable('rate_limits').set({ window_start_at: AT }).where('key', '=', created[0].key),
        ),
      );
      const body = bodyProbe();
      const response = await invalid(target, body.stream);
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(body.pulls()).toBe(1);
      expect(await fileCount(target, definition.name)).toBeUndefined();
    });

    test('未ログインの要求は本文を読まず、どの回数枠にも数えない', async () => {
      const target = await createTarget();
      const before = await rateRows();
      const body = bodyProbe();
      const response = await post(app, definition, { slug: target.slug, rawBody: body.stream });
      expect(response.status).toBe(401);
      expect(await errorCodeOf(response)).toBe('unauthenticated');
      expect(body.pulls()).toBe(0);
      expect(await rateRows()).toEqual(before);
    });

    test('組織に入れない要求は本文を読まず、どの回数枠にも数えない', async () => {
      const target = await createTarget();
      const other = await createTarget();
      const before = await rateRows();
      const body = bodyProbe();
      const response = await post(app, definition, {
        slug: other.slug,
        token: target.member.token,
        rawBody: body.stream,
      });
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('not_found');
      expect(body.pulls()).toBe(0);
      expect(await rateRows()).toEqual(before);
    });

    test('読み取りトークンの要求は本文を読まず、どの回数枠にも数えない', async () => {
      const target = await createTarget();
      const bearer = await bearerFor(target.member, 'read');
      const before = await rateRows();
      const body = bodyProbe();
      const response = await post(app, definition, { slug: target.slug, bearer, rawBody: body.stream });
      expect(response.status).toBe(403);
      expect(await errorCodeOf(response)).toBe('forbidden');
      expect(body.pulls()).toBe(0);
      expect(await rateRows()).toEqual(before);
    });
  });
}

test('要求数の枠は操作とアカウントごとに分かれる', async () => {
  const target = await createTarget();
  for (let index = 0; index < 60; index++) {
    const response = await post(app, workspaceWikiUpload, {
      slug: target.slug,
      token: target.member.token,
      rawBody: '{broken',
    });
    expect(response.status).toBe(400);
  }
  const limited = bodyProbe();
  expect(
    (await post(app, workspaceWikiUpload, { slug: target.slug, token: target.member.token, rawBody: limited.stream }))
      .status,
  ).toBe(429);
  expect(limited.pulls()).toBe(0);

  const anotherOperation = bodyProbe();
  expect(
    (
      await post(app, orgWikiUpload, {
        slug: target.slug,
        token: target.member.token,
        rawBody: anotherOperation.stream,
      })
    ).status,
  ).toBe(400);
  expect(anotherOperation.pulls()).toBe(1);

  const anotherAccount = bodyProbe();
  expect(
    (
      await post(app, workspaceWikiUpload, {
        slug: target.slug,
        token: target.leader.token,
        rawBody: anotherAccount.stream,
      })
    ).status,
  ).toBe(400);
  expect(anotherAccount.pulls()).toBe(1);
});
