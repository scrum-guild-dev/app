import { generateKeyBetween } from 'fractional-indexing';
import { sql, type RawBuilder } from 'kysely';
import { crossOrganizationEntries, type OrganizationDb } from './entries.ts';
import { compileOnlyKysely } from './entry.ts';
import type { OrganizationTables } from './tables.ts';
const compiler = compileOnlyKysely<OrganizationTables>();
function raw<Row>(db: Pick<OrganizationDb, 'statement'>, query: RawBuilder<Row>) {
  return db.statement(() => ({ compile: () => query.compile(compiler) }));
}

import type { WikiPage } from '../../shared/operations/wiki/index.ts';

// 同じ処理を、組織の Wiki の操作からも使えるよう、Wiki の範囲を明示する。
export type WikiScope = { workspaceId: string } | { organizationId: string };
function scopeOf(alias: string, scope: WikiScope): RawBuilder<boolean> {
  return 'workspaceId' in scope
    ? sql<boolean>`${sql.ref(`${alias}.workspace_id`)} = ${scope.workspaceId}`
    : sql<boolean>`${sql.ref(`${alias}.organization_id`)} = ${scope.organizationId}`;
}
function openScope(db: OrganizationDb, scope: WikiScope): RawBuilder<boolean> {
  return 'workspaceId' in scope
    ? sql<boolean>`EXISTS (SELECT 1 FROM workspaces WHERE id = ${scope.workspaceId} AND organization_id = ${db.organizationId} AND closed_at IS NULL)`
    : sql<boolean>`${scope.organizationId} = ${db.organizationId}`;
}

// 共通の表は結合しない。上限だけを、組織の道具が共通の入口から別に読んで渡す。
// 容量判定は書く文の中で行うため、並行した作成・保存・添付で古い集計を使わない。
export function organizationStorageBytes(db: OrganizationDb): RawBuilder<number> {
  const organizationId = db.organizationId;
  return sql<number>`(
    WITH scoped_pages AS (
      SELECT id, title, body_md FROM wiki_pages WHERE organization_id = ${organizationId}
      UNION ALL
      SELECT id, title, body_md FROM wiki_pages WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${organizationId})
    )
    SELECT coalesce(sum(bytes), 0) FROM (
      SELECT length(CAST(title AS BLOB)) + length(CAST(body_md AS BLOB)) AS bytes FROM scoped_pages
      UNION ALL
      SELECT length(CAST(r.title AS BLOB)) + length(CAST(r.body_md AS BLOB)) FROM wiki_page_revisions r INNER JOIN scoped_pages p ON p.id = r.page_id
      UNION ALL
      SELECT size_bytes FROM attachments WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${organizationId})
    )
  )`;
}

const pageColumns = ['id', 'parent_id', 'position', 'title', 'body_md', 'version', 'created_at', 'updated_at'] as const;
export async function readWikiPage(
  db: OrganizationDb,
  scope: WikiScope,
  pageId: string,
  revision?: number,
): Promise<WikiPage | undefined> {
  if (revision !== undefined) {
    const page = await readWikiPage(db, scope, pageId);
    if (page === undefined) return undefined;
    const historical = await db.first(
      db.statement((q) =>
        q
          .selectFrom('wiki_page_revisions as r')
          .innerJoin('wiki_pages as p', 'p.id', 'r.page_id')
          .select(['r.title', 'r.body_md', 'r.version', 'r.saved_at as updated_at'])
          .where('p.id', '=', pageId)
          .where(scopeOf('p', scope))
          .where('p.deleted_at', 'is', null)
          .where('r.version', '=', revision),
      ),
    );
    return historical === undefined ? undefined : { ...page, ...historical };
  }
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('wiki_pages')
        .select(pageColumns)
        .where('id', '=', pageId)
        .where(scopeOf('wiki_pages', scope))
        .where('deleted_at', 'is', null),
    ),
  );
}

export async function readWikiRevisions(db: OrganizationDb, scope: WikiScope, pageId: string) {
  const page = await readWikiPage(db, scope, pageId);
  if (page === undefined) return undefined;
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('wiki_page_revisions as r')
        .innerJoin('wiki_pages as p', 'p.id', 'r.page_id')
        .innerJoin('users as u', (join) =>
          join.onRef('u.id', '=', 'r.saved_by').on('u.organization_id', '=', db.organizationId),
        )
        .select(['r.version', 'r.title', 'r.saved_by', 'u.name as saved_by_name', 'r.saved_at'])
        .where('p.id', '=', pageId)
        .where(scopeOf('p', scope))
        .where('p.deleted_at', 'is', null)
        .orderBy('r.version', 'desc')
        .limit(100),
    ),
  );
}

export async function readWikiTree(db: OrganizationDb, scope: WikiScope) {
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('wiki_pages')
        .select(['id', 'parent_id', 'position', 'title', 'version'])
        .where(scopeOf('wiki_pages', scope))
        .where('deleted_at', 'is', null)
        .orderBy('parent_id')
        .orderBy('position')
        .orderBy('id'),
    ),
  );
}

// 祖先は10段で打ち切る。終点が根でなければ循環、欠けた親、または深すぎる木なので通さない。
function ancestors(scope: WikiScope, parentId: string | null) {
  return sql`WITH RECURSIVE ancestors(id, parent_id, depth) AS (
    SELECT p.id, p.parent_id, 1 FROM wiki_pages p WHERE p.id = ${parentId} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL
    UNION ALL
    SELECT p.id, p.parent_id, a.depth + 1 FROM wiki_pages p INNER JOIN ancestors a ON p.id = a.parent_id
    WHERE ${scopeOf('p', scope)} AND p.deleted_at IS NULL AND a.depth < 10
  )`;
}
export async function wikiParentFits(db: OrganizationDb, scope: WikiScope, parentId: string | null): Promise<boolean> {
  if (parentId === null) return true;
  const row = await db.first(
    raw(
      db,
      sql<{
        fits: number;
      }>`${ancestors(scope, parentId)} SELECT EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL AND depth <= 9) AS fits`,
    ),
  );
  return row?.fits === 1;
}

type Content = { title: string; body_md: string; userId: string; at: string };
export async function insertWikiPage(
  db: OrganizationDb,
  scope: WikiScope,
  pageId: string,
  parentId: string | null,
  content: Content,
  quota: number,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(content.title).length + new TextEncoder().encode(content.body_md).length;
  const last = await db.first(
    db.statement((q) =>
      q
        .selectFrom('wiki_pages')
        .select('position')
        .where(scopeOf('wiki_pages', scope))
        .where('parent_id', 'is', parentId)
        .where('deleted_at', 'is', null)
        .orderBy('position', 'desc')
        .orderBy('id', 'desc')
        .limit(1),
    ),
  );
  const position = generateKeyBetween(last?.position ?? null, null);
  const [inserted] = await db.batch([
    raw(
      db,
      sql`${ancestors(scope, parentId)}
      INSERT INTO wiki_pages(id, organization_id, workspace_id, parent_id, title, version, position, created_by, updated_by, created_at, updated_at, deleted_at, deleted_by, body_md)
      SELECT ${pageId}, ${'organizationId' in scope ? scope.organizationId : null}, ${'workspaceId' in scope ? scope.workspaceId : null}, ${parentId}, ${content.title}, 1,
        ${position},
        ${content.userId}, ${content.userId}, ${content.at}, ${content.at}, NULL, NULL, ${content.body_md}
      WHERE ${openScope(db, scope)} AND (${parentId} IS NULL OR EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL AND depth <= 9))
        AND ${organizationStorageBytes(db)} + ${bytes * 2} <= ${quota}`,
    ),
    raw(
      db,
      sql`INSERT INTO wiki_page_revisions(page_id, version, title, body_md, saved_by, saved_at)
      SELECT id, version, title, body_md, updated_by, updated_at FROM wiki_pages p
      WHERE id = ${pageId} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL AND changes() > 0`,
    ),
  ]);
  return inserted.changes > 0;
}

export async function updateWikiPage(
  db: OrganizationDb,
  scope: WikiScope,
  pageId: string,
  readVersion: number,
  content: Content,
  quota: number,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(content.title).length + new TextEncoder().encode(content.body_md).length;
  const [updated] = await db.batch([
    raw(
      db,
      sql`UPDATE wiki_pages AS p SET title = ${content.title}, body_md = ${content.body_md}, version = version + 1, updated_by = ${content.userId}, updated_at = ${content.at}
      WHERE p.id = ${pageId} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL AND p.version = ${readVersion} AND ${openScope(db, scope)}
      AND ${organizationStorageBytes(db)} - length(CAST(p.title AS BLOB)) - length(CAST(p.body_md AS BLOB)) + ${bytes * 2}
        - (SELECT coalesce(sum(length(CAST(r.title AS BLOB)) + length(CAST(r.body_md AS BLOB))), 0) FROM wiki_page_revisions r WHERE r.page_id = p.id AND r.version <= ${readVersion + 1 - 100}) <= ${quota}`,
    ),
    raw(
      db,
      sql`INSERT INTO wiki_page_revisions(page_id, version, title, body_md, saved_by, saved_at)
      SELECT id, version, title, body_md, updated_by, updated_at FROM wiki_pages p
      WHERE p.id = ${pageId} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL AND changes() > 0`,
    ),
    raw(
      db,
      sql`DELETE FROM wiki_page_revisions WHERE page_id = ${pageId} AND version <= ${readVersion + 1 - 100}
      AND changes() > 0 AND EXISTS (SELECT 1 FROM wiki_pages p WHERE p.id = wiki_page_revisions.page_id AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL)`,
    ),
  ]);
  return updated.changes > 0;
}

export async function insertUploadedAttachment(
  db: OrganizationDb,
  row: {
    id: string;
    workspaceId: string;
    objectKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    userId: string;
    at: string;
  },
  quota: number,
): Promise<boolean> {
  const [result] = await db.batch([
    raw(
      db,
      sql`INSERT INTO attachments(id, workspace_id, task_id, story_id, epic_id, comment_id, object_key, file_name, content_type, size_bytes, uploaded_by, attached_at, created_at)
    SELECT ${row.id}, ${row.workspaceId}, NULL, NULL, NULL, NULL, ${row.objectKey}, ${row.fileName}, ${row.contentType}, ${row.sizeBytes}, ${row.userId}, NULL, ${row.at}
    WHERE ${openScope(db, { workspaceId: row.workspaceId })} AND ${organizationStorageBytes(db)} + ${row.sizeBytes} <= ${quota}`,
    ),
  ]);
  return result.changes > 0;
}

// 1回の定期処理は DB ごとに32版と32ページまで。途中で落ちても、消した版の続きから次回進む。
// ページの行は親の外部キーのため残し、内容だけを固定の墓標にする。期限後は復元の文も通らない。
export async function cleanupDeletedWiki(
  env: Env,
  at: Date,
  limit = 32,
): Promise<{ revisions: number; pages: number }> {
  const cutoff = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const deleted = { revisions: 0, pages: 0 };
  for (const db of crossOrganizationEntries(env)) {
    const [revisions, pages] = await db.batch([
      raw(
        db,
        sql`DELETE FROM wiki_page_revisions WHERE (page_id, version) IN (
        SELECT r.page_id, r.version FROM wiki_page_revisions r INNER JOIN wiki_pages p ON p.id = r.page_id
        WHERE p.deleted_at <= ${cutoff} ORDER BY p.deleted_at, p.id, r.version LIMIT ${limit}
      )`,
      ),
      raw(
        db,
        sql`UPDATE wiki_pages SET title = '-', body_md = '' WHERE id IN (
        SELECT p.id FROM wiki_pages p WHERE p.deleted_at <= ${cutoff}
          AND (p.title <> '-' OR p.body_md <> '')
          AND NOT EXISTS (SELECT 1 FROM wiki_page_revisions r WHERE r.page_id = p.id)
        ORDER BY p.deleted_at, p.id LIMIT ${limit}
      )`,
      ),
    ]);
    deleted.revisions += revisions.changes;
    deleted.pages += pages.changes;
  }
  return deleted;
}
