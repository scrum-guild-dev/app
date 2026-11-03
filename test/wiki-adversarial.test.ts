import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import {
  orgDb,
  insertWikiPage,
  updateWikiPage,
  readWikiPage,
  cleanupDeletedWiki,
  insertUploadedAttachment,
} from '../src/server/db/index.ts';
import { parseWikiFrontmatter } from '../src/shared/wiki.ts';
import { createTarget } from './operations/world.ts';
import { AT, uuidv7 } from './factories.ts';
import { runStatementsForTest } from '../src/server/db/testing.ts';
import { restoreWikiPageSql } from '../scripts/restore-wiki-page-sql.ts';

async function fixture() {
  const target = await createTarget();
  const db = orgDb(env, target.organization.verified);
  const scope = { workspaceId: target.workspace.id };
  const content = { title: '😀', body_md: '日', userId: target.member.userId!, at: AT };
  async function insert(body = content, quota = 1000000) {
    const id = uuidv7();
    expect(await insertWikiPage(db, scope, id, null, body, quota)).toBe(true);
    return id;
  }
  return { target, db, scope, content, insert };
}

test('UTF-8 の合計が上限ちょうどなら保存でき、1バイト少ないと本文も版も作らない', async () => {
  const f = await fixture();
  // 絵文字4バイト + 日3バイトを最新行と版に保存するので14バイト。
  const id = await f.insert(f.content, 14);
  const next = uuidv7();
  expect(await insertWikiPage(f.db, f.scope, next, null, f.content, 27)).toBe(false);
  expect(await readWikiPage(f.db, f.scope, next)).toBeUndefined();
  expect((await readWikiPage(f.db, f.scope, id))?.version).toBe(1);
});

test('同じミリ秒の保存が競合しても成功した版だけを残し、古い保存では掃除しない', async () => {
  const f = await fixture();
  const id = await f.insert();
  const results = await Promise.all([
    updateWikiPage(f.db, f.scope, id, 1, { ...f.content, body_md: '先', at: AT }, 1000000),
    updateWikiPage(f.db, f.scope, id, 1, { ...f.content, body_md: '後', at: AT }, 1000000),
  ]);
  expect(results.sort()).toEqual([false, true]);
  const rows = await f.db.rows(
    f.db.statement((q) => q.selectFrom('wiki_page_revisions').selectAll().where('page_id', '=', id).orderBy('version')),
  );
  expect(rows.map((row) => row.version)).toEqual([1, 2]);
  expect(rows[1]?.body_md).toBe((await readWikiPage(f.db, f.scope, id))?.body_md);
  expect(rows.every((row) => row.saved_at === AT)).toBe(true);
});

test('上限の100版では消える版のバイト数を差し引き、容量ちょうどの101版目を保存できる', async () => {
  const f = await fixture();
  const original = { ...f.content, title: 'a', body_md: 'x' };
  const id = await f.insert(original);
  await f.db.batch([
    f.db.statement((q) =>
      q
        .updateTable('wiki_pages')
        .set({ version: 100 })
        .where('id', '=', id)
        .where('workspace_id', '=', f.scope.workspaceId),
    ),
    ...Array.from({ length: 99 }, (_, index) =>
      f.db.statement((q) =>
        q.insertInto('wiki_page_revisions').values({
          page_id: id,
          version: index + 2,
          title: 'a',
          body_md: 'x',
          saved_by: f.content.userId,
          saved_at: AT,
        }),
      ),
    ),
  ]);
  // 直す前は202バイト。題+本文が3バイトへ増え、旧行2バイトと最古版2バイトが消えるので204。
  expect(await updateWikiPage(f.db, f.scope, id, 100, { ...original, body_md: 'xx' }, 203)).toBe(false);
  expect((await readWikiPage(f.db, f.scope, id))?.version).toBe(100);
  expect(await updateWikiPage(f.db, f.scope, id, 100, { ...original, body_md: 'xx' }, 204)).toBe(true);
  const rows = await f.db.rows(
    f.db.statement((q) =>
      q.selectFrom('wiki_page_revisions').select('version').where('page_id', '=', id).orderBy('version'),
    ),
  );
  expect(rows).toHaveLength(100);
  expect(rows[0]?.version).toBe(2);
  expect(rows.at(-1)?.version).toBe(101);
});

test('組織内の別ワークスペースからの添付とWikiを同時に足しても共有上限を超えない', async () => {
  const f = await fixture();
  const id = uuidv7();
  const attachmentId = uuidv7();
  const results = await Promise.all([
    insertWikiPage(f.db, f.scope, id, null, f.content, 20), // 14 bytes
    insertUploadedAttachment(
      f.db,
      {
        id: attachmentId,
        workspaceId: f.target.otherWorkspace.id,
        objectKey: 'adversarial-key',
        fileName: 'a.txt',
        contentType: 'text/plain',
        sizeBytes: 10,
        userId: f.target.admin.userId!,
        at: AT,
      },
      20,
    ),
  ]);
  expect(results.sort()).toEqual([false, true]);
  const wiki = await readWikiPage(f.db, f.scope, id);
  const attachment = await f.db.first(
    f.db.statement((q) =>
      q
        .selectFrom('attachments')
        .select('size_bytes')
        .where('id', '=', attachmentId)
        .where('workspace_id', '=', f.target.otherWorkspace.id),
    ),
  );
  expect((wiki ? 14 : 0) + (attachment?.size_bytes ?? 0)).toBeLessThanOrEqual(20);
});

test('閉じる前に読んだページでも、閉じた後の書く文は本文と版を変更しない', async () => {
  const f = await fixture();
  const id = await f.insert();
  await f.db.batch([
    f.db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ closed_at: AT })
        .where('id', '=', f.scope.workspaceId)
        .where('organization_id', '=', f.target.organization.id),
    ),
  ]);
  expect(await updateWikiPage(f.db, f.scope, id, 1, { ...f.content, body_md: '変えた本文' }, 1000000)).toBe(false);
  expect(await insertWikiPage(f.db, f.scope, uuidv7(), id, f.content, 1000000)).toBe(false);
  expect((await readWikiPage(f.db, f.scope, id))?.body_md).toBe('日');
});

test('30日境界の1ミリ秒前は保持し、ちょうど30日で消した本文を通常APIへ戻さない', async () => {
  const f = await fixture();
  const id = await f.insert();
  const deleted = new Date(AT);
  await f.db.batch([
    f.db.statement((q) =>
      q
        .updateTable('wiki_pages')
        .set({ deleted_at: AT, deleted_by: f.content.userId })
        .where('id', '=', id)
        .where('workspace_id', '=', f.scope.workspaceId),
    ),
  ]);
  const boundary = new Date(deleted.getTime() + 30 * 86400000);
  await cleanupDeletedWiki(env, new Date(boundary.getTime() - 1));
  let row = await f.db.first(
    f.db.statement((q) =>
      q.selectFrom('wiki_pages').select('body_md').where('id', '=', id).where('workspace_id', '=', f.scope.workspaceId),
    ),
  );
  expect(row?.body_md).toBe('日');
  await cleanupDeletedWiki(env, boundary);
  row = await f.db.first(
    f.db.statement((q) =>
      q.selectFrom('wiki_pages').select('body_md').where('id', '=', id).where('workspace_id', '=', f.scope.workspaceId),
    ),
  );
  expect(row?.body_md).toBe('');
  expect(await readWikiPage(f.db, f.scope, id)).toBeUndefined();
});

test('空のfrontmatterは読めるYAMLとして扱い、その下のMarkdownだけを描く', () => {
  expect(parseWikiFrontmatter('---\n---\n# 手順')).toEqual({
    title: null,
    body: '# 手順',
    invalid: false,
    properties: [],
  });
});

test('削除後に元の親が10段目へ動いても、復元するページは11段目にならず最上段へ戻す', async () => {
  const f = await fixture();
  const at = new Date().toISOString();
  const parent = await f.insert();
  const child = uuidv7();
  expect(await insertWikiPage(f.db, f.scope, child, parent, { ...f.content, at }, 1000000)).toBe(true);
  await f.db.batch([
    f.db.statement((q) =>
      q
        .updateTable('wiki_pages')
        .set({ deleted_at: at, deleted_by: f.content.userId })
        .where('id', '=', child)
        .where('workspace_id', '=', f.scope.workspaceId),
    ),
  ]);
  let ancestor: string | null = null;
  for (let depth = 1; depth <= 9; depth++) {
    const id = uuidv7();
    expect(await insertWikiPage(f.db, f.scope, id, ancestor, { ...f.content, at }, 1000000)).toBe(true);
    ancestor = id;
  }
  await f.db.batch([
    f.db.statement((q) =>
      q
        .updateTable('wiki_pages')
        .set({ parent_id: ancestor })
        .where('id', '=', parent)
        .where('workspace_id', '=', f.scope.workspaceId),
    ),
  ]);
  await runStatementsForTest(env, [restoreWikiPageSql(f.target.organization.id, child)]);
  expect((await readWikiPage(f.db, f.scope, child))?.parent_id).toBeNull();
  expect((await readWikiPage(f.db, f.scope, parent))?.parent_id).toBe(ancestor);
});
