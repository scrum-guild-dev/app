import { generateNKeysBetween } from 'fractional-indexing';
import { sql, type RawBuilder } from 'kysely';
import { crossOrganizationEntries, type OrganizationDb } from './entries.ts';
import { compileOnlyKysely } from './entry.ts';
import type { OrganizationTables } from './tables.ts';
import { tailPosition } from './tail-position.ts';
const compiler = compileOnlyKysely<OrganizationTables>();
function raw<Row>(db: Pick<OrganizationDb, 'statement'>, query: RawBuilder<Row>) {
  return db.statement(() => ({ compile: () => query.compile(compiler) }));
}

import { WIKI_SEARCH_MAX_BYTES, WIKI_SEARCH_MAX_PAGES } from '../../shared/wiki.ts';
import { searchWordsOf } from '../../shared/backlog-filter.ts';
import type { WikiSearchResult, WikiPage } from '../../shared/operations/wiki/index.ts';

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

// 管理者に返す容量の内訳。Wiki は題と本文の UTF-8 バイト数で、過去版と削除後の保持分を含める。
export async function readOrganizationStorageUsage(db: OrganizationDb) {
  const wikiBytes = (condition: RawBuilder<boolean>) => sql<number>`(
    WITH scoped_pages AS (SELECT id, title, body_md FROM wiki_pages WHERE ${condition})
    SELECT coalesce(sum(bytes), 0) FROM (
      SELECT length(CAST(title AS BLOB)) + length(CAST(body_md AS BLOB)) AS bytes FROM scoped_pages
      UNION ALL
      SELECT length(CAST(r.title AS BLOB)) + length(CAST(r.body_md AS BLOB)) FROM wiki_page_revisions r INNER JOIN scoped_pages p ON p.id = r.page_id
    )
  )`;
  const [organizationWiki, workspaces] = await db.batch([
    db.statement((q) => q.selectNoFrom(wikiBytes(sql<boolean>`organization_id = ${db.organizationId}`).as('bytes'))),
    db.statement((q) =>
      q
        .selectFrom('workspaces as w')
        .select([
          'w.id',
          'w.name',
          sql<number>`${wikiBytes(sql<boolean>`workspace_id = w.id`)} + (SELECT coalesce(sum(size_bytes), 0) FROM attachments WHERE workspace_id = w.id)`.as(
            'used_bytes',
          ),
        ])
        .where('w.organization_id', '=', db.organizationId)
        .orderBy('w.name')
        .orderBy('w.id'),
    ),
  ] as const);
  const organizationWikiBytes = Number(organizationWiki.rows[0]?.bytes ?? 0);
  return {
    used_bytes: organizationWikiBytes + workspaces.rows.reduce((sum, row) => sum + Number(row.used_bytes), 0),
    organization_wiki_bytes: organizationWikiBytes,
    workspaces: workspaces.rows.map((row) => ({ ...row, used_bytes: Number(row.used_bytes) })),
  };
}

const pageColumns = [
  'id',
  'parent_id',
  'position',
  'title',
  'body_md',
  'version',
  'created_by',
  'created_at',
  'updated_at',
] as const;
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

// octet_length(列) はSQLiteのレコードの長さを使い、本文を読み込まずバイト数を数える。
// 予算の検査と検索を同じ文に置き、検査後にページが増える競合でも予算を超えない。
export async function searchWikiPages(
  db: OrganizationDb,
  scope: WikiScope,
  query: string,
): Promise<{ limited: boolean; pages: WikiSearchResult[] }> {
  const words = searchWordsOf(query);
  if (!words.length) return { limited: false, pages: [] };
  const titleHits = words.map((word) => sql<boolean>`instr(p.title_search, lower(${word})) > 0`);
  const hits = words.map(
    (word, index) => sql<boolean>`(${titleHits[index]} OR instr(p.body_search, lower(${word})) > 0)`,
  );
  const row = await db.first(
    raw(
      db,
      sql<{ limited: number; pages_json: string }>`
    WITH budget AS (
      SELECT count(*) > ${WIKI_SEARCH_MAX_PAGES} OR coalesce(sum(bytes), 0) > ${WIKI_SEARCH_MAX_BYTES} AS limited
      FROM (
        SELECT octet_length(title) + octet_length(body_md) AS bytes FROM wiki_pages p
        WHERE ${scopeOf('p', scope)} AND p.deleted_at IS NULL LIMIT ${WIKI_SEARCH_MAX_PAGES + 1}
      )
    ), pages AS (
      SELECT id, title, lower(title) AS title_search, lower(body_md) AS body_search, updated_at
      FROM wiki_pages p WHERE ${scopeOf('p', scope)} AND p.deleted_at IS NULL LIMIT -1
    )
    SELECT limited, CASE WHEN limited THEN '[]' ELSE (
      SELECT json_group_array(json_object('id', id, 'title', title, 'matched_in', matched_in)) FROM (
        SELECT p.id, p.title, CASE WHEN (${sql.join(titleHits, sql` OR `)}) THEN 'title' ELSE 'body' END AS matched_in
        FROM pages p WHERE ${sql.join(hits, sql` AND `)}
        ORDER BY (${sql.join(titleHits, sql` AND `)}) DESC, p.updated_at DESC, p.id LIMIT 50
      )
    ) END AS pages_json FROM budget
  `,
    ),
  );
  return { limited: row?.limited === 1, pages: JSON.parse(row?.pages_json ?? '[]') as WikiSearchResult[] };
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
  return (
    (await insertWikiPages(
      db,
      scope,
      parentId,
      [{ id: pageId, title: content.title, body_md: content.body_md }],
      content.userId,
      content.at,
      quota,
    )) !== null
  );
}

export async function insertWikiPages(
  db: OrganizationDb,
  scope: WikiScope,
  parentId: string | null,
  pages: { id: string; title: string; body_md: string }[],
  userId: string,
  at: string,
  quota: number,
) {
  const bytes =
    pages.reduce(
      (total, page) =>
        total + new TextEncoder().encode(page.title).length + new TextEncoder().encode(page.body_md).length,
      0,
    ) * 2;
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
  const positions = generateNKeysBetween(last?.position ?? null, null, pages.length);
  const nodes = pages.map((page, index) => ({
    id: page.id,
    parent_id: parentId,
    position: positions[index]!,
    title: page.title,
    version: 1,
  }));
  // 最初のINSERTだけで全件の容量を確かめる。残りは、この要求の先頭ページが入ったことを条件にする。
  // batch内には他の要求が割り込まない。条件不成立がSQLエラーにならなくても一部成功させない。
  const [inserted] = await db.batch(
    pages.flatMap((content, index) => [
      raw(
        db,
        sql`${ancestors(scope, parentId)}
      INSERT INTO wiki_pages(id, organization_id, workspace_id, parent_id, title, version, position, created_by, updated_by, created_at, updated_at, deleted_at, deleted_by, body_md)
      SELECT ${content.id}, ${'organizationId' in scope ? scope.organizationId : null}, ${'workspaceId' in scope ? scope.workspaceId : null}, ${parentId}, ${content.title}, 1,
        ${positions[index]},
        ${userId}, ${userId}, ${at}, ${at}, NULL, NULL, ${content.body_md}
      WHERE ${openScope(db, scope)} AND (${parentId} IS NULL OR EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL AND depth <= 9))
        AND ${
          index === 0
            ? sql<boolean>`${organizationStorageBytes(db)} + ${bytes} <= ${quota}`
            : sql<boolean>`EXISTS (SELECT 1 FROM wiki_pages p WHERE p.id = ${pages[0]!.id} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL)`
        }`,
      ),
      raw(
        db,
        sql`INSERT INTO wiki_page_revisions(page_id, version, title, body_md, saved_by, saved_at)
      SELECT id, version, title, body_md, updated_by, updated_at FROM wiki_pages p
      WHERE id = ${content.id} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL AND changes() > 0`,
      ),
    ]),
  );
  return inserted!.changes > 0 ? nodes : null;
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

export async function deleteWikiPage(
  db: OrganizationDb,
  scope: WikiScope,
  current: Pick<WikiPage, 'id' | 'created_by' | 'parent_id'>,
  userId: string,
  at: string,
): Promise<boolean> {
  // 子は書く時点で集める。読む間に子が増えても、消した親の下へ取り残さない。
  // window関数で元の順と末尾の位置を一度だけ確定し、行の更新に引きずらせない。
  const positions = sql`
    SELECT c.id, ${tailPosition(
      sql`(SELECT sibling.position FROM wiki_pages sibling
        WHERE ${scopeOf('sibling', scope)} AND sibling.parent_id IS ${current.parent_id}
          AND sibling.deleted_at IS NULL
        ORDER BY sibling.position DESC, sibling.id DESC LIMIT 1)`,
      sql`row_number() OVER (ORDER BY c.position, c.id)`,
      sql`count(*) OVER ()`,
    )} AS position
    FROM wiki_pages c WHERE ${scopeOf('c', scope)}
      AND c.parent_id = ${current.id} AND c.deleted_at IS NULL`;
  const [deleted] = await db.batch([
    raw(
      db,
      sql`UPDATE wiki_pages AS p SET deleted_at = ${at}, deleted_by = ${userId}
      WHERE p.id = ${current.id} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL
        AND p.created_by = ${current.created_by} AND p.parent_id IS ${current.parent_id}
        AND ${openScope(db, scope)}
        AND (${current.parent_id} IS NULL OR EXISTS (
          SELECT 1 FROM wiki_pages parent WHERE parent.id = ${current.parent_id}
            AND ${scopeOf('parent', scope)} AND parent.deleted_at IS NULL
        ))`,
    ),
    raw(
      db,
      sql`WITH positions AS MATERIALIZED (${positions})
      UPDATE wiki_pages AS p
      SET parent_id = ${current.parent_id}, position = (SELECT position FROM positions WHERE id = p.id)
      WHERE ${scopeOf('p', scope)} AND p.parent_id = ${current.id} AND p.deleted_at IS NULL
        AND p.id IN (SELECT id FROM positions) AND changes() > 0
        AND EXISTS (SELECT 1 FROM wiki_pages deleted WHERE deleted.id = ${current.id}
          AND ${scopeOf('deleted', scope)} AND deleted.deleted_at = ${at} AND deleted.deleted_by = ${userId})`,
    ),
  ]);
  return deleted.changes > 0;
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

// 移す先の祖先と移す部分木をそれぞれ10段で打ち切り、書き込み時にも循環と深さを検証する。
function moveTree(scope: WikiScope, pageId: string, parentId: string | null) {
  return sql`${ancestors(scope, parentId)}, subtree(id, depth) AS (
    SELECT p.id, 1 FROM wiki_pages p WHERE p.id = ${pageId} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL
    UNION ALL
    SELECT p.id, s.depth + 1 FROM subtree s CROSS JOIN wiki_pages p ON p.parent_id = s.id
    WHERE ${scopeOf('p', scope)} AND p.deleted_at IS NULL AND s.depth < 10
  )`;
}
function treeFits(parentId: string | null, pageId: string) {
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM ancestors WHERE id = ${pageId})
    AND (${parentId} IS NULL OR EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL))
    AND coalesce((SELECT max(depth) FROM ancestors), 0) + (SELECT max(depth) FROM subtree) <= 10`;
}
export async function wikiMoveProblem(db: OrganizationDb, scope: WikiScope, pageId: string, parentId: string | null) {
  const row = await db.first(
    raw(
      db,
      sql<{ cycle: number; fits: number }>`${moveTree(scope, pageId, parentId)}
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${pageId}) AS cycle, ${treeFits(parentId, pageId)} AS fits`,
    ),
  );
  return row?.cycle ? 'cycle' : row?.fits ? null : 'too_deep';
}
type MoveSnapshot = { id: string; parent_id: string | null; position: string };
export function wikiMoveStatement(
  db: OrganizationDb,
  scope: WikiScope,
  current: MoveSnapshot,
  parentId: string | null,
  position: string,
  snapshots: readonly MoveSnapshot[],
) {
  const guards = sql<boolean>`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(snapshots)}) snapshot
    WHERE NOT EXISTS (SELECT 1 FROM wiki_pages g WHERE g.id = json_extract(snapshot.value, '$.id')
      AND ${scopeOf('g', scope)} AND g.deleted_at IS NULL
      AND g.parent_id IS json_extract(snapshot.value, '$.parent_id') AND g.position = json_extract(snapshot.value, '$.position')))`;
  return raw(
    db,
    sql`${moveTree(scope, current.id, parentId)}
    UPDATE wiki_pages AS p SET parent_id = ${parentId}, position = ${position}
    WHERE p.id = ${current.id} AND ${scopeOf('p', scope)} AND p.deleted_at IS NULL
      AND p.parent_id IS ${current.parent_id} AND p.position = ${current.position}
      AND ${openScope(db, scope)} AND ${treeFits(parentId, current.id)}
      AND ${guards}`,
  );
}
export async function writeWikiMove(
  db: OrganizationDb,
  scope: WikiScope,
  current: MoveSnapshot,
  parentId: string | null,
  plan: { position: string; renumber: { id: string; from: string; to: string }[] },
  snapshots: readonly MoveSnapshot[],
) {
  const [moved] = await db.batch([
    wikiMoveStatement(db, scope, current, parentId, plan.position, snapshots),
    ...plan.renumber.map((row) =>
      raw(
        db,
        sql`UPDATE wiki_pages AS p SET position = ${row.to}
      WHERE p.id = ${row.id} AND ${scopeOf('p', scope)} AND p.parent_id IS ${parentId}
        AND p.deleted_at IS NULL AND p.position = ${row.from} AND changes() > 0`,
      ),
    ),
  ]);
  return moved.changes > 0;
}
