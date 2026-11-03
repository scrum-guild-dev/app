const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// SQL を生成するだけ。本番に流すのは運用者。削除したページだけを戻し、子の現在の親を変えない。
export function restoreWikiPageSql(organizationId: string, pageId: string): string {
  if (!UUID.test(organizationId) || !UUID.test(pageId)) throw new Error('組織とページの ID は小文字の UUID で渡す');
  const organization = `'${organizationId}'`;
  const page = `'${pageId}'`;
  const sameWiki = `(a.organization_id IS p.organization_id AND a.workspace_id IS p.workspace_id)`;
  const parent = `(CASE WHEN p.parent_id IS NULL THEN NULL WHEN EXISTS (WITH RECURSIVE ancestors(id, parent_id, depth) AS (SELECT a.id, a.parent_id, 1 FROM wiki_pages a WHERE a.id = p.parent_id AND ${sameWiki} AND a.deleted_at IS NULL UNION ALL SELECT a.id, a.parent_id, t.depth + 1 FROM wiki_pages a JOIN ancestors t ON a.id = t.parent_id WHERE ${sameWiki} AND a.deleted_at IS NULL AND t.depth < 10) SELECT 1 FROM ancestors WHERE parent_id IS NULL AND depth <= 9) THEN p.parent_id ELSE NULL END)`;
  // 時刻はD1の時計で判定する。掃除前でも30日経過したページは戻せない。
  return `UPDATE wiki_pages AS p SET parent_id = ${parent}, position = coalesce((SELECT a.position FROM wiki_pages a WHERE ${sameWiki} AND a.parent_id IS ${parent} AND a.deleted_at IS NULL ORDER BY a.position DESC, a.id DESC LIMIT 1), 'a0') || 'V', deleted_at = NULL, deleted_by = NULL WHERE p.id = ${page} AND (p.organization_id = ${organization} OR p.workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${organization})) AND p.deleted_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') AND EXISTS (SELECT 1 FROM wiki_page_revisions r WHERE r.page_id = p.id AND r.version = p.version) RETURNING id, parent_id, title, version;\n`;
}
