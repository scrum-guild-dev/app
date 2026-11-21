import { sql, type QueryCreator } from 'kysely';
import type { OrganizationTables } from './tables.ts';
import { unindexed } from './unindexed.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

// INDEXED BY は候補ではなく必須。部分索引の条件は下の問い合わせと一緒に保つ。
// 索引を消すときは、先にこの指定を外した版を出してから別のマイグレーションで消す。
const activeTasksByStory = sql<OrganizationTables['tasks']>`tasks`.as<'tasks'>(sql`tasks INDEXED BY tasks_story`);
const openTasksByStory = sql<OrganizationTables['tasks']>`tasks`.as<'tasks'>(sql`tasks INDEXED BY tasks_story_open`);

// ストーリー内の位置順では tasks_story を使い、ID が分かる場合は主キーで引けるようにする。
// 親なしの story_id を索引に使わせると、別ワークスペースの NULL 行まで読まれる。
export function backlogTasksUnder(
  from: From,
  workspaceId: string,
  storyId: string | null,
  lookup: 'position' | 'id' = 'position',
) {
  const table = storyId !== null && lookup === 'position' ? activeTasksByStory : 'tasks';
  const tasks = from
    .selectFrom([table])
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.tray', '=', 'backlog')
    .where('tasks.deleted_at', 'is', null);
  return storyId === null
    ? tasks.where(unindexed('tasks.story_id'), 'is', null)
    : tasks.where('tasks.story_id', '=', storyId);
}

// CROSS JOIN と索引指定で、ストーリーごとに配下を引く。未完了用の部分索引を使う場合は完了日時の条件も付ける。
export function backlogTasksUnderStories(from: From, workspaceId: string, scope: 'all' | 'open') {
  const table = scope === 'open' ? openTasksByStory : activeTasksByStory;
  return from
    .selectFrom('stories')
    .crossJoin(table)
    .whereRef('tasks.story_id', '=', 'stories.id')
    .whereRef('tasks.workspace_id', '=', 'stories.workspace_id')
    .where('stories.workspace_id', '=', workspaceId)
    .where('stories.deleted_at', 'is', null)
    .where('tasks.tray', '=', 'backlog')
    .where('tasks.deleted_at', 'is', null)
    .$if(scope === 'open', (query) => query.where('tasks.completed_at', 'is', null));
}
