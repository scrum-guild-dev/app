import { env } from 'cloudflare:workers';
import { test, expect } from 'vitest';
import { commonDb, orgDb, insertWikiPage, cleanupDeletedWiki, readWikiPage } from '../src/server/db/index.ts';
import { runStatementsForTest } from '../src/server/db/testing.ts';
import { restoreWikiPageSql } from '../scripts/restore-wiki-page-sql.ts';
import { purgeOrganizationStatements, purgeOrganizationCountSql } from '../scripts/purge-organization-sql.ts';
import { firstRowForTest } from '../src/server/db/testing.ts';
import { createTarget } from './operations/world.ts';
import { uuidv7 } from './factories.ts';
import { upload, pngFile, attachmentRows, objectKeysOf } from './attachment-helpers.ts';
import { errorCodeOf } from './operations/harness.ts';

const now = new Date();
const stamp = now.toISOString();
const ago = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
async function fixture() {
  const target = await createTarget();
  const db = orgDb(env, target.organization.verified);
  const scope = { workspaceId: target.workspace.id };
  async function page(parent: string | null = null) {
    const id = uuidv7();
    expect(
      await insertWikiPage(
        db,
        scope,
        id,
        parent,
        { title: '手順', body_md: '本文', userId: target.member.userId!, at: stamp },
        1000000,
      ),
    ).toBe(true);
    return id;
  }
  async function deleted(id: string, at: string) {
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('wiki_pages')
          .set({ deleted_at: at, deleted_by: target.member.userId! })
          .where('id', '=', id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    ]);
  }
  return { target, db, scope, page, deleted };
}

test('30日未満は保持し、30日ちょうどで版を消して最新の内容を墓標にする', async () => {
  const f = await fixture();
  const recent = await f.page();
  const expired = await f.page();
  await f.deleted(recent, ago(29));
  await f.deleted(expired, ago(30));
  await cleanupDeletedWiki(env, now);
  const rows = await f.db.rows(
    f.db.statement((q) => q.selectFrom('wiki_pages').selectAll().where('workspace_id', '=', f.scope.workspaceId)),
  );
  expect(rows.find((row) => row.id === recent)?.body_md).toBe('本文');
  expect(rows.find((row) => row.id === expired)).toMatchObject({ title: '-', body_md: '', deleted_at: ago(30) });
  const revisions = await f.db.rows(
    f.db.statement((q) => q.selectFrom('wiki_page_revisions').selectAll().where('page_id', 'in', [recent, expired])),
  );
  expect(revisions.map((row) => row.page_id)).toEqual([recent]);
  expect(await readWikiPage(f.db, f.scope, recent)).toBeUndefined();
  expect(await readWikiPage(f.db, f.scope, expired)).toBeUndefined();
});

test('掃除は版の上限まで進み、再実行で続けてから本文を消す', async () => {
  const f = await fixture();
  const id = await f.page();
  await f.db.batch([
    f.db.statement((q) =>
      q.insertInto('wiki_page_revisions').values(
        [2, 3].map((version) => ({
          page_id: id,
          version,
          title: '版',
          body_md: '内容',
          saved_by: f.target.member.userId!,
          saved_at: stamp,
        })),
      ),
    ),
  ]);
  await f.deleted(id, ago(31));
  await cleanupDeletedWiki(env, now, 1);
  let row = await f.db.first(
    f.db.statement((q) =>
      q.selectFrom('wiki_pages').selectAll().where('id', '=', id).where('workspace_id', '=', f.scope.workspaceId),
    ),
  );
  expect(row?.body_md).toBe('本文');
  await cleanupDeletedWiki(env, now, 1);
  await cleanupDeletedWiki(env, now, 1);
  row = await f.db.first(
    f.db.statement((q) =>
      q.selectFrom('wiki_pages').selectAll().where('id', '=', id).where('workspace_id', '=', f.scope.workspaceId),
    ),
  );
  expect(row?.body_md).toBe('');
});

test('運用者の復元は対象だけを元の生きた親へ戻し、持ち上げられた子の場所を変えない', async () => {
  const f = await fixture();
  const parent = await f.page();
  const id = await f.page(parent);
  const child = await f.page(parent); // 削除時に持ち上がった子を模す
  await f.deleted(id, ago(1));
  await runStatementsForTest(env, [restoreWikiPageSql(f.target.organization.id, id)]);
  expect((await readWikiPage(f.db, f.scope, id))?.parent_id).toBe(parent);
  expect((await readWikiPage(f.db, f.scope, child))?.parent_id).toBe(parent);
});

test('消えた親の下の復元は最上段へ戻し、別組織と30日を過ぎたページは戻せない', async () => {
  const f = await fixture();
  const other = await createTarget();
  const parent = await f.page();
  const id = await f.page(parent);
  await f.deleted(parent, ago(1));
  await f.deleted(id, ago(1));
  await runStatementsForTest(env, [restoreWikiPageSql(other.organization.id, id)]);
  expect(await readWikiPage(f.db, f.scope, id)).toBeUndefined();
  await runStatementsForTest(env, [restoreWikiPageSql(f.target.organization.id, id)]);
  expect((await readWikiPage(f.db, f.scope, id))?.parent_id).toBeNull();
  await f.deleted(id, ago(31));
  await runStatementsForTest(env, [restoreWikiPageSql(f.target.organization.id, id)]);
  expect(await readWikiPage(f.db, f.scope, id)).toBeUndefined();
});

test('Wiki の容量で添付を断り、R2 のファイルを補償で消す', async () => {
  const f = await fixture();
  await f.page(); // 題6+本文6の最新と版で24 bytes
  const common = commonDb(env);
  await common.batch([
    common.statement((q) =>
      q.updateTable('organizations').set({ attachment_quota_bytes: 30 }).where('id', '=', f.target.organization.id),
    ),
  ]);
  const response = await upload(f.target, { file: pngFile(1) });
  expect(response.status).toBe(409);
  expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
  expect(await attachmentRows(f.target)).toHaveLength(0);
  expect(await objectKeysOf(f.target.organization.id)).toHaveLength(0);
});

test('32版ずつ組織を消せ、版が残る間は親子ページを消さず再実行で進める', async () => {
  const f = await fixture();
  const id = await f.page();
  const child = await f.page(id);
  await f.db.batch(
    Array.from({ length: 40 }, (_, i) =>
      f.db.statement((q) =>
        q.insertInto('wiki_page_revisions').values({
          page_id: child,
          version: i + 2,
          title: '版',
          body_md: '内容',
          saved_by: f.target.member.userId!,
          saved_at: stamp,
        }),
      ),
    ),
  );
  const common = commonDb(env);
  await common.batch([
    common.statement((q) =>
      q
        .updateTable('organizations')
        .set({ suspended_at: ago(32), purge_on: ago(31).slice(0, 10) })
        .where('id', '=', f.target.organization.id),
    ),
  ]);
  // Wiki の外部キーを持つお気に入りも先に消す。文の追加で固定の件数がずれないよう対象で選ぶ。
  const steps = purgeOrganizationStatements(f.target.organization.id).filter((statement) =>
    /^DELETE FROM (favorites|wiki_page_revisions|wiki_pages) WHERE /.test(statement),
  );
  await runStatementsForTest(env, steps);
  let counts = await firstRowForTest(env, purgeOrganizationCountSql(f.target.organization.id));
  expect(counts?.wiki_page_revisions).toBeGreaterThan(0);
  expect(counts?.wiki_pages).toBe(2);
  for (let i = 0; i < 4; i++) await runStatementsForTest(env, steps);
  counts = await firstRowForTest(env, purgeOrganizationCountSql(f.target.organization.id));
  expect(counts?.wiki_page_revisions).toBe(0);
  expect(counts?.wiki_pages).toBe(0);
});

test('Wiki と添付を並行で追加しても共有の上限は超えない', async () => {
  const f = await fixture();
  const common = commonDb(env);
  await common.batch([
    common.statement((q) =>
      q.updateTable('organizations').set({ attachment_quota_bytes: 12 }).where('id', '=', f.target.organization.id),
    ),
  ]);
  const [wiki, attachment] = await Promise.all([
    insertWikiPage(
      f.db,
      f.scope,
      uuidv7(),
      null,
      { title: '題', body_md: 'a', userId: f.target.member.userId!, at: stamp },
      12,
    ),
    upload(f.target, { file: pngFile(1) }),
  ]);
  expect([wiki ? 200 : 409, attachment.status].sort()).toEqual([200, 409]);
});
