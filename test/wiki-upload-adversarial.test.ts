import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, runStatementsForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiCreate, orgWikiUpload, workspaceWikiUpload } from '../src/shared/operations/wiki/index.ts';
import { WIKI_UPLOAD_MAX_REQUEST_BYTES } from '../src/shared/wiki-transfer.ts';
import { AT, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const twoFiles = [
  { file_name: 'a.md', body_md: 'b' },
  { file_name: 'c.md', body_md: 'd' },
];

for (const kind of ['organization', 'workspace'] as const) {
  const organization = kind === 'organization';
  const definition = organization ? orgWikiUpload : workspaceWikiUpload;
  function input(target: Target, extra: Record<string, unknown> = {}) {
    return { ...(organization ? {} : { workspace_id: target.workspace.id }), files: twoFiles, ...extra };
  }
  function upload(target: Target, extra: Record<string, unknown> = {}, requestEnv: Env = env) {
    return post(app, definition, {
      slug: target.slug,
      token: target.member.token,
      body: input(target, extra),
      env: requestEnv,
    });
  }
  async function stored(target: Target) {
    const db = orgDb(env, target.organization.verified);
    const pages = await db.rows(
      db.statement((q) => {
        const query = q.selectFrom('wiki_pages').selectAll();
        return organization
          ? query.where('organization_id', '=', target.organization.id)
          : query.where('workspace_id', '=', target.workspace.id);
      }),
    );
    const revisions = await db.rows(
      db.statement((q) => {
        const query = q
          .selectFrom('wiki_page_revisions')
          .innerJoin('wiki_pages', 'wiki_pages.id', 'wiki_page_revisions.page_id')
          .select(['wiki_page_revisions.page_id', 'wiki_page_revisions.title']);
        return organization
          ? query.where('wiki_pages.organization_id', '=', target.organization.id)
          : query.where('wiki_pages.workspace_id', '=', target.workspace.id);
      }),
    );
    return { pages, revisions };
  }
  async function count(target: Target, accountId = target.member.accountId) {
    const db = commonDb(env);
    return (
      await db.first(
        db.statement((q) =>
          q.selectFrom('rate_limits').select('count').where('key', '=', `operation:${definition.name}:${accountId}`),
        ),
      )
    )?.count;
  }
  async function seed(target: Target) {
    const db = orgDb(env, target.organization.verified);
    const id = uuidv7();
    await db.batch([
      db.statement((q) =>
        q.insertInto('wiki_pages').values({
          id,
          organization_id: organization ? target.organization.id : null,
          workspace_id: organization ? null : target.workspace.id,
          parent_id: null,
          position: 'a0',
          title: '架空の親',
          body_md: '本文',
          version: 1,
          created_by: target.member.userId!,
          updated_by: target.member.userId!,
          created_at: AT,
          updated_at: AT,
        }),
      ),
    ]);
    return id;
  }
  describe(`${kind}: 一括取り込みを崩す追加の検査`, () => {
    test('JSON中の不正なUTF-8バイトを置換して保存せず、400で何も作らない', async () => {
      const target = await createTarget();
      const source = JSON.stringify(input(target, { files: [{ file_name: 'a.md', body_md: '#' }] }));
      const bytes = new TextEncoder().encode(source);
      bytes[bytes.indexOf(35)] = 0xff;
      const response = await post(app, definition, {
        slug: target.slug,
        token: target.member.token,
        rawBody: bytes,
      });
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(await stored(target)).toEqual({ pages: [], revisions: [] });
      expect(await count(target)).toBeUndefined();
    });

    test('JSONのエスケープで12MBになる20件×10万字も、本文上限内なら取り込める', async () => {
      const target = await createTarget();
      const files = Array.from({ length: 20 }, (_, index) => ({
        file_name: `file${index}.md`,
        body_md: '\u0001'.repeat(100000),
      }));
      expect(new TextEncoder().encode(JSON.stringify(input(target, { files }))).length).toBeGreaterThan(11_000_000);
      const response = await upload(target, { files });
      expect(response.status).toBe(200);
      const rows = await stored(target);
      expect(rows.pages).toHaveLength(20);
      expect(rows.revisions).toHaveLength(20);
      expect(rows.pages.every((page) => page.body_md === files[0].body_md)).toBe(true);
      expect(await count(target)).toBe(20);
    });

    test('Content-Lengthが16MiBを超えれば入力を検証する前に413で断り、重みを数えない', async () => {
      const target = await createTarget();
      const response = await post(app, definition, {
        slug: target.slug,
        token: target.member.token,
        body: input(target),
        headers: { 'Content-Length': String(WIKI_UPLOAD_MAX_REQUEST_BYTES + 1) },
      });
      expect(response.status).toBe(413);
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(await stored(target)).toEqual({ pages: [], revisions: [] });
      expect(await count(target)).toBeUndefined();
    });

    test('Content-Lengthの無い本文も16MiBを超えたら読み取りを中止し、413で断る', async () => {
      const target = await createTarget();
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = await post(app, definition, {
        slug: target.slug,
        token: target.member.token,
        rawBody: stream,
      });
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(await stored(target)).toEqual({ pages: [], revisions: [] });
      expect(await count(target)).toBeUndefined();
    });

    test('同じ組織への並行要求も全件の合算容量を超えず、片方だけを一括保存する', async () => {
      const target = await createTarget();
      const common = commonDb(env);
      await common.batch([
        common.statement((q) =>
          q.updateTable('organizations').set({ attachment_quota_bytes: 11 }).where('id', '=', target.organization.id),
        ),
      ]);
      const responses = await Promise.all([upload(target), upload(target)]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const rejected = responses.find((response) => response.status === 409)!;
      expect(await errorCodeOf(rejected)).toBe('attachment_quota_exceeded');
      const rows = await stored(target);
      expect(rows.pages).toHaveLength(2);
      expect(rows.revisions).toHaveLength(2);
      expect(await count(target)).toBe(4);
    });

    test('2件目の版のINSERTがSQLエラーになると、1件目を含むページと版を巻き戻す', async () => {
      const target = await createTarget();
      const trigger = `wiki_upload_fail_${uuidv7().replaceAll('-', '')}`;
      // D1本体のトランザクションを確かめる。beforeBatchで投げる検査とは別に途中のSQLを失敗させる。
      await runStatementsForTest(env, [
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON wiki_page_revisions
         WHEN NEW.title = '一括取り込みの失敗用'
         BEGIN SELECT RAISE(ABORT, 'wiki-upload-test'); END`,
      ]);
      try {
        const response = await upload(target, {
          files: [twoFiles[0], { file_name: '一括取り込みの失敗用.md', body_md: '本文' }],
        });
        expect(response.status).toBe(500);
        expect(await stored(target)).toEqual({ pages: [], revisions: [] });
        expect(await count(target)).toBe(2);
      } finally {
        await runStatementsForTest(env, [`DROP TRIGGER ${trigger}`]);
      }
    });

    test('親を検証した後に削除されても、SQL条件で全件拒否する', async () => {
      const target = await createTarget();
      const parentId = await seed(target);
      const db = orgDb(env, target.organization.verified);
      let fired = false;
      const hooked = envWithD1Hooks(env, {
        afterQuery: async (sql) => {
          if (fired || !sql.includes('order by "position"')) return;
          fired = true;
          await db.batch([
            db.statement((q) => {
              const update = q
                .updateTable('wiki_pages')
                .set({ deleted_at: AT, deleted_by: target.member.userId! })
                .where('id', '=', parentId);
              return organization
                ? update.where('organization_id', '=', target.organization.id)
                : update.where('workspace_id', '=', target.workspace.id);
            }),
          ]);
        },
      });
      const response = await upload(target, { parent_id: parentId }, hooked);
      expect(fired).toBe(true);
      expect(response.status).toBe(404);
      const rows = await stored(target);
      expect(rows.pages).toHaveLength(1);
      expect(rows.pages[0].deleted_at).toBe(AT);
      expect(rows.revisions).toHaveLength(0);
    });
  });
}

test('ワークスペースの権限が無い人を断る前には、取り込む件数を数えない', async () => {
  const target = await createTarget();
  const response = await post(app, workspaceWikiUpload, {
    slug: target.slug,
    token: target.bystander.token,
    body: { workspace_id: target.workspace.id, files: twoFiles },
  });
  expect(response.status).toBe(404);
  const db = commonDb(env);
  expect(
    await db.first(
      db.statement((q) =>
        q
          .selectFrom('rate_limits')
          .select('count')
          .where('key', '=', `operation:workspace-wiki-upload:${target.bystander.accountId}`),
      ),
    ),
  ).toBeUndefined();
});

test('アップロードの16MiB上限を追加しても、既存の単一ページ作成の1MiB上限は広がらない', async () => {
  const target = await createTarget();
  const response = await post(app, orgWikiCreate, {
    slug: target.slug,
    token: target.member.token,
    rawBody: JSON.stringify({ title: '架空の手順', body_md: '本文' }) + ' '.repeat(1024 * 1024),
  });
  expect(response.status).toBe(413);
  expect(await errorCodeOf(response)).toBe('invalid_input');
});
