// loading-bench 専用の使い捨て D1。backlog-bench.ts の行の生成を流用する。
// seed（seed/data.sql）のあおば開発と、その管理者（ミナト）と一般のユーザー（ハルカ）
const ORGANIZATION_ID = '019a0000-0000-7000-8000-000000000201';
const ADMIN_USER_ID = '019a0000-0000-7000-8000-000000000301';
const MEMBER_USER_ID = '019a0000-0000-7000-8000-000000000302';
const AT = '2026-10-01T00:00:00.000Z';

type Shape = { workspaceId: string; prefix: string; completedPerTen: number };

// 完了の割合は7件ずつの塊を10個に分け、そのうち8個を完了にする。
// 担当、リポジトリ、検索の語の振り方（番号の余りで決める）と重ならないようにする
// 測る行の ID。形（prefix）と表（kind）ごとに桁をずらし、seed の ID（019a…）とぶつけない
function id(prefix: string, n: number, kind = '0'): string {
  return `019b${prefix}${kind}00-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

// SQL の中で ID を作る式（id() と同じ形）
const sqlId = (prefix: string, kind: string, expr: string) =>
  `printf('019b${prefix}${kind}00-0000-7000-8000-%012d', ${expr})`;

function shapeSql(shape: Shape): string {
  const { workspaceId: ws, prefix } = shape;
  return `
INSERT INTO workspaces (id, organization_id, name, timezone, vocabulary, created_by, created_at, updated_at) VALUES
  ('${ws}', '${ORGANIZATION_ID}', '測る形 ${prefix}', 'Asia/Tokyo', 'scrum', '${ADMIN_USER_ID}', '${AT}', '${AT}');
INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, joined_at) VALUES
  ('${id(prefix, 1, 'm')}', '${ws}', '${ADMIN_USER_ID}', 'leader', '2026-10-01', '${AT}'),
  ('${id(prefix, 2, 'm')}', '${ws}', '${MEMBER_USER_ID}', 'member', '2026-10-01', '${AT}');
INSERT INTO categories (id, workspace_id, name, is_billed_monthly, position, created_at, updated_at) VALUES
  ('${id(prefix, 1, 'c')}', '${ws}', '保守', 0, 'a0', '${AT}', '${AT}'),
  ('${id(prefix, 2, 'c')}', '${ws}', '追加案件', 1, 'a1', '${AT}', '${AT}');
INSERT INTO repositories (id, workspace_id, name, position, created_at, updated_at) VALUES
  ('${id(prefix, 1, 'r')}', '${ws}', 'shop-api', 'a0', '${AT}', '${AT}'),
  ('${id(prefix, 2, 'r')}', '${ws}', 'shop-web', 'a1', '${AT}', '${AT}');
INSERT INTO epics (id, workspace_id, title, category_id, reward_tier, requester_user_id, created_by, position, created_at, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
  SELECT ${sqlId(prefix, 'e', 'i')}, '${ws}', '大きな目標 ' || i,
    CASE WHEN i % 2 = 0 THEN '${id(prefix, 1, 'c')}' END, 'small', '${ADMIN_USER_ID}', '${ADMIN_USER_ID}',
    printf('a0%04dV', i), '${AT}', '${AT}' FROM n;
INSERT INTO stories (id, workspace_id, epic_id, title, category_id, created_by, position, created_at, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
  SELECT ${sqlId(prefix, 's', 'i')}, '${ws}',
    CASE WHEN i <= 80 THEN ${sqlId(prefix, 'e', '(i - 1) % 10 + 1')} END,
    'ひとまとまりの目標 ' || i,
    CASE WHEN i > 80 AND i % 3 = 0 THEN '${id(prefix, 2, 'c')}' END,
    '${ADMIN_USER_ID}', printf('a0%05dV', i), '${AT}', '${AT}' FROM n;
INSERT INTO tasks (id, workspace_id, is_imported, tray, title, story_id, category_id, repository_id, assignee_user_id, points,
    completed_at, completed_by, position, created_by, created_at, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
  SELECT ${sqlId(prefix, 't', 'i')}, '${ws}', 0, 'backlog',
    CASE WHEN i % 97 = 0 THEN '請求書の出力を直す ' || i ELSE 'バックログの作業 ' || i END,
    CASE WHEN i % 5 <> 0 THEN ${sqlId(prefix, 's', '(i - 1) % 100 + 1')} END,
    CASE WHEN i % 5 = 0 AND i % 7 = 0 THEN '${id(prefix, 1, 'c')}' END,
    CASE WHEN i % 4 = 0 THEN '${id(prefix, 1, 'r')}' END,
    CASE i % 3 WHEN 0 THEN '${ADMIN_USER_ID}' WHEN 1 THEN '${MEMBER_USER_ID}' END,
    CASE i % 5 WHEN 0 THEN NULL WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3 ELSE 5 END,
    CASE WHEN (i / 7) % 10 < ${shape.completedPerTen} THEN '${AT}' END,
    CASE WHEN (i / 7) % 10 < ${shape.completedPerTen} THEN '${ADMIN_USER_ID}' END,
    printf('a0%06dV', i), '${ADMIN_USER_ID}', '${AT}', '${AT}' FROM n;
`;
}

export const loadingWorkspace = id('1', 1);
export const loadingEpic = id('1', 1, 'e');
export function loadingFixtureSql(): string {
  return (
    shapeSql({ workspaceId: loadingWorkspace, prefix: '1', completedPerTen: 8 }) +
    `
INSERT INTO board_columns (id, workspace_id, name, position, created_at, updated_at) VALUES ('${id('1', 1, 'b')}', '${loadingWorkspace}', '未着手', 'a0', '${AT}', '${AT}');
INSERT INTO sprints (id, workspace_id, name, start_on, end_on, status, started_at, started_by, created_at, updated_at) VALUES ('${id('1', 1, 'p')}', '${loadingWorkspace}', '計測', date('now'), date('now', '+13 days'), 'active', '${AT}', '${ADMIN_USER_ID}', '${AT}', '${AT}');
UPDATE tasks SET sprint_id='${id('1', 1, 'p')}', column_id='${id('1', 1, 'b')}', column_position=position, today_on=date('now') WHERE workspace_id='${loadingWorkspace}' AND completed_at IS NULL AND rowid IN (SELECT rowid FROM tasks WHERE workspace_id='${loadingWorkspace}' AND completed_at IS NULL LIMIT 30);
` +
    ['organization', 'workspace']
      .map(
        (scope, index) => `
INSERT INTO wiki_pages (id, ${scope}_id, title, version, position, created_by, updated_by, created_at, updated_at, body_md)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100)
SELECT printf('019c000${index}-0000-7000-8000-%012d', i), '${index === 0 ? ORGANIZATION_ID : loadingWorkspace}', '手順 ' || i, 1, printf('a0%04dV',i), '${ADMIN_USER_ID}', '${ADMIN_USER_ID}', '${AT}', '${AT}', '計測用の手順' FROM n;
`,
      )
      .join('\n')
  );
}
