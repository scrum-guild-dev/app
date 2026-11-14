// 解約した組織のデータを消す SQL を組む（docs/operations.md の「解約した組織のデータを消す」）。
// 人が本番の D1 に、1文ずつ `wrangler d1 execute --remote --command` で流す。`--file` は取り込みの API を使い、流している間は
// D1 全体がクエリに答えなくなるので使わない。`--command` は束縛の値を取れないので、組織の ID を SQL に埋める。
// Workers の実行環境のテスト（test/purge-organization.test.ts）が同じ SQL を流すので、Node の API を使わない。
//
// - 1文を1行に書く。行は手順書の `--command "<文>"` にそのまま入るよう、`"`、`$`、`` ` ``、`\`、`!` を含めない（scripts/purge-organization.test.ts）
// - どの文にも「その組織が解約で停止していて、消す予定日を過ぎている」の EXISTS を付ける。一時的な停止、停止していない組織、
//   予定日の当日より前の組織、無い ID では何も消えない
// - 外部キーの子から順に消し、organizations の行を最後に消す。途中で止まっても、同じ順で流し直せば続きから消える
// - favorites と Wiki は先頭の専用の文で消し、残りは TABLES の順で消す。Wiki の2表は TABLES に含めず別に件数を照合する
// - 共通の表のうち消すのは organization_contracts（組織の契約）と organizations の行だけ。accounts、account_logins、sessions、api_tokens、oauth_states、rate_limits は消さない
//   （アカウントはほかの組織でも使う。アカウントをどうするかは #407。セッションと API トークンはアカウントに結ぶ。入れる組織を失った人の
//   セッションとトークンは、その人の次のリクエストか期限切れで消える）
// - 共通の表（organizations）を組織の中の表の文から引く。DB を1つにしている今だけの書き方で、組織ごとに DB を分けるときは
//   ガードの確かめを共通の DB で先に行う形に直す（docs/data-model.md の「データベースの分け方」）
// - 組織の中の表を足したら、ここに消す文を足す。足し忘れると test/purge-organization.test.ts が落ちる

// UUID の形（小文字の16進）。組織の ID は小文字で作る（src/server/uuid.ts）
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 組織で絞る条件の形。epic は workspace_id を持たず、エピックを通して組織に結ぶ表（epic_party_members）
type Scope = 'organization' | 'workspace' | 'epic' | 'task' | 'connection' | 'user';

// 通常の削除と残件数の照合に使う表の一覧（Wiki の2表は別枠）。favorites は Wiki より先に専用の文で消し、通常の削除文からは除く。
// ほかは外部キーの子から順。xp_grants は自分の表を指す（reverses_grant_id）が、1文で組織の行をまとめて消すので、文の終わりの検査に当たらない
const TABLES: readonly (readonly [table: string, scope: Scope])[] = [
  ['notifications', 'user'],
  ['favorites', 'user'],
  ['xp_grants', 'workspace'],
  ['thanks', 'workspace'],
  ['attachments', 'workspace'],
  ['comments', 'workspace'],
  ['completions', 'workspace'],
  ['change_logs', 'organization'],
  ['organization_holidays', 'organization'],
  ['sprint_entries', 'workspace'],
  ['task_field_values', 'task'],
  ['task_source_payloads', 'task'],
  ['task_sources', 'task'],
  ['connection_status_mappings', 'connection'],
  ['connection_scopes', 'connection'],
  ['connections', 'workspace'],
  ['tasks', 'workspace'],
  ['delegatees', 'organization'],
  ['stories', 'workspace'],
  ['epic_party_members', 'epic'],
  ['epics', 'workspace'],
  ['sprints', 'workspace'],
  ['board_columns', 'workspace'],
  ['detail_fields', 'workspace'],
  ['categories', 'workspace'],
  ['repositories', 'workspace'],
  ['invitations', 'workspace'],
  ['memberships', 'workspace'],
  ['workspace_point_rates', 'workspace'],
  ['workspaces', 'organization'],
  ['users', 'organization'],
  // 共通の表の組織の契約。organizations を指すので、organizations の行の直前に消す
  ['organization_contracts', 'organization'],
];

function quotedId(organizationId: string): string {
  if (!UUID.test(organizationId)) {
    throw new Error(`組織の ID は小文字の UUID の形で渡す: ${JSON.stringify(organizationId)}`);
  }
  return `'${organizationId}'`;
}

function scopeOf(scope: Scope, id: string): string {
  const workspaces = `SELECT id FROM workspaces WHERE organization_id = ${id}`;
  if (scope === 'organization') return `organization_id = ${id}`;
  if (scope === 'user') return `user_id IN (SELECT id FROM users WHERE organization_id = ${id})`;
  if (scope === 'workspace') return `workspace_id IN (${workspaces})`;
  if (scope === 'task') return `task_id IN (SELECT id FROM tasks WHERE workspace_id IN (${workspaces}))`;
  if (scope === 'connection')
    return `connection_id IN (SELECT id FROM connections WHERE workspace_id IN (${workspaces}))`;
  return `epic_id IN (SELECT id FROM epics WHERE workspace_id IN (${workspaces}))`;
}

// 消す文。外部キーの子から順に並び、最後が organizations の行
export function purgeOrganizationStatements(organizationId: string): string[] {
  const id = quotedId(organizationId);
  const guard = `EXISTS (SELECT 1 FROM organizations WHERE id = ${id} AND suspended_at IS NOT NULL AND purge_on IS NOT NULL AND purge_on < date('now'))`;
  return [
    // 組織の Wiki の印は workspace_id が空なので、本人の組織で絞る。対象より先に消す。
    `DELETE FROM favorites WHERE ${scopeOf('user', id)} AND ${guard}`,
    ...[
      'organization_id = ' + id,
      'workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ' + id + ')',
    ].map(
      (scope) =>
        `DELETE FROM wiki_page_revisions WHERE (page_id, version) IN (SELECT r.page_id, r.version FROM wiki_page_revisions r JOIN wiki_pages p ON p.id = r.page_id WHERE p.${scope} ORDER BY r.page_id, r.version LIMIT 32) AND ${guard}`,
    ),
    ...[
      'organization_id = ' + id,
      'workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ' + id + ')',
    ].map(
      (scope) =>
        `DELETE FROM wiki_pages WHERE id IN (SELECT p.id FROM wiki_pages p WHERE p.${scope} AND NOT EXISTS (SELECT 1 FROM wiki_page_revisions r WHERE r.page_id = p.id) AND NOT EXISTS (SELECT 1 FROM wiki_pages c WHERE c.parent_id = p.id) ORDER BY p.id LIMIT 32) AND ${guard}`,
    ),
    // 取り込み元の応答は1件が最大512KBで、上限いっぱいの組織では0.5GB前後になる。1文で消すと30秒の上限に当たりうるので、
    // Wiki の版と同じく1文32件に分ける（流し方は docs/operations.md の「解約した組織のデータを消す」）。下の全件の文は、残りを拾う
    `DELETE FROM task_source_payloads WHERE task_id IN (SELECT p.task_id FROM task_source_payloads p WHERE p.task_id IN (SELECT id FROM tasks WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${id})) ORDER BY p.task_id LIMIT 32) AND ${guard}`,
    ...TABLES.filter(([table]) => table !== 'favorites').map(
      ([table, scope]) => `DELETE FROM ${table} WHERE ${scopeOf(scope, id)} AND ${guard}`,
    ),
    `DELETE FROM organizations WHERE id = ${id} AND ${guard}`,
  ];
}

// 消す文を1行に1文で書いたもの（コメントの行は無い）。手順書はこの行を1つずつ `--command` で流す
export function purgeOrganizationSql(organizationId: string): string {
  return `${purgeOrganizationStatements(organizationId).join('\n')}\n`;
}

// 残りを数える1行の SELECT。組織の slug と停止の状態（suspended_at、purge_on）と、organizations と消す表ごとの、その組織の行の数を返す。
// 流す前と流した後に同じ文で数え、比べて判定する。slug は、一覧から控えた slug と見比べて ID の取り違えに気づくため
// （docs/operations.md の「解約した組織のデータを消す」）
export function purgeOrganizationCountSql(organizationId: string): string {
  const id = quotedId(organizationId);
  const columns = [
    `(SELECT slug FROM organizations WHERE id = ${id}) AS slug`,
    `(SELECT suspended_at FROM organizations WHERE id = ${id}) AS suspended_at`,
    `(SELECT purge_on FROM organizations WHERE id = ${id}) AS purge_on`,
    `(SELECT count(*) FROM organizations WHERE id = ${id}) AS organizations`,
    `((SELECT count(*) FROM wiki_pages WHERE organization_id = ${id}) + (SELECT count(*) FROM wiki_pages WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${id}))) AS wiki_pages`,
    `((SELECT count(*) FROM wiki_page_revisions WHERE page_id IN (SELECT id FROM wiki_pages WHERE organization_id = ${id})) + (SELECT count(*) FROM wiki_page_revisions WHERE page_id IN (SELECT id FROM wiki_pages WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${id})))) AS wiki_page_revisions`,
    ...TABLES.map(([table, scope]) => `(SELECT count(*) FROM ${table} WHERE ${scopeOf(scope, id)}) AS ${table}`),
  ];
  return `SELECT ${columns.join(', ')}\n`;
}
