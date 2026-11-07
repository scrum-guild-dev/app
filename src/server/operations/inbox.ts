// 受信箱の一覧（inbox-list）と、バックログへ入れる書き込み（inbox-to-backlog）。docs/data-model.md の「書き込みの単位」の「受信箱からバックログへ」
import { now } from '../../shared/clock.ts';
import { INBOX_LIST_LIMIT, inboxList, inboxToBacklog } from '../../shared/operations/task/index.ts';
import {
  jsonList,
  jsonPairRows,
  previousStatementChanged,
  tailPosition,
  uuidv7Sql,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { refOf, repositoryRow } from './definition-refs.ts';
import { implement } from './implement.ts';
import { lastTaskPosition } from './tree-delete.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

// 受信箱の一覧。組織の中の表は、ワークスペースを結合して組織で絞る。共通の表とは結合しない
export const inboxListOperation = implement(inboxList, async ({ db, workspace }) => {
  const workspaceId = workspace.workspaceId;
  const inboxTasks = (q: From) =>
    q
      .selectFrom('tasks')
      .innerJoin('workspaces as w', 'w.id', 'tasks.workspace_id')
      .where('w.organization_id', '=', db.organizationId)
      .where('tasks.workspace_id', '=', workspaceId)
      .where('tasks.tray', '=', 'inbox')
      .where('tasks.deleted_at', 'is', null);

  const [rows, totalRow, connectionRow, repositories] = await Promise.all([
    db.rows(
      db.statement((q) =>
        inboxTasks(q)
          .innerJoin('task_sources as s', (join) =>
            join.onRef('s.task_id', '=', 'tasks.id').on('s.workspace_id', '=', workspaceId),
          )
          .innerJoin('connections as c', (join) =>
            join.onRef('c.id', '=', 's.connection_id').on('c.workspace_id', '=', workspaceId),
          )
          .leftJoin('repositories as r', (join) =>
            join
              .onRef('r.id', '=', 'tasks.repository_id')
              .on('r.workspace_id', '=', workspaceId)
              .on('r.deleted_at', 'is', null),
          )
          .leftJoin('users as u', (join) =>
            join.onRef('u.id', '=', 'tasks.assignee_user_id').on('u.organization_id', '=', db.organizationId),
          )
          .select([
            'tasks.id',
            'tasks.title',
            'tasks.created_at',
            's.source_key',
            's.source_url',
            's.source_container_name',
            'c.name as connection_name',
            'r.id as repository_id',
            'r.name as repository_name',
            'u.id as assignee_id',
            'u.name as assignee_name',
          ])
          .orderBy('tasks.created_at', 'desc')
          .orderBy('tasks.id', 'desc')
          .limit(INBOX_LIST_LIMIT),
      ),
    ),
    db.first(
      db.statement((q) =>
        inboxTasks(q)
          .innerJoin('task_sources as s', (join) =>
            join.onRef('s.task_id', '=', 'tasks.id').on('s.workspace_id', '=', workspaceId),
          )
          .innerJoin('connections as c', (join) =>
            join.onRef('c.id', '=', 's.connection_id').on('c.workspace_id', '=', workspaceId),
          )
          .select((eb) => eb.fn.countAll<number>().as('n')),
      ),
    ),
    db.first(
      db.statement((q) =>
        q
          .selectFrom('connections')
          .innerJoin('workspaces as w', 'w.id', 'connections.workspace_id')
          .where('w.organization_id', '=', db.organizationId)
          .where('connections.workspace_id', '=', workspaceId)
          .where('connections.deleted_at', 'is', null)
          .select((eb) => [
            eb.fn.countAll<number>().as('n'),
            eb.fn.max('connections.last_success_at').as('last_success_at'),
          ]),
      ),
    ),
    db.rows(
      db.statement((q) =>
        q
          .selectFrom('repositories')
          .innerJoin('workspaces as w', 'w.id', 'repositories.workspace_id')
          .where('w.organization_id', '=', db.organizationId)
          .where('repositories.workspace_id', '=', workspaceId)
          .where('repositories.deleted_at', 'is', null)
          .select(['repositories.id', 'repositories.name'])
          .orderBy('repositories.position')
          .orderBy('repositories.id'),
      ),
    ),
  ]);

  return {
    tasks: rows.map((row) => ({
      id: row.id,
      title: row.title,
      source_key: row.source_key,
      source_url: row.source_url,
      source_container_name: row.source_container_name,
      connection_name: row.connection_name,
      repository: row.repository_id === null ? null : { id: row.repository_id, name: row.repository_name ?? '' },
      assignee: row.assignee_id === null ? null : { id: row.assignee_id, name: row.assignee_name ?? '' },
      arrived_at: row.created_at,
    })),
    total: Number(totalRow?.n ?? 0),
    connection_count: Number(connectionRow?.n ?? 0),
    last_success_at: connectionRow?.last_success_at ?? null,
    repositories,
  };
});

// 選んだ全件が、このワークスペースの受信箱にある、という条件（件数が選んだ数と等しい）。書く文のすべてが持つ
function allInInbox(q: From, workspaceId: string, taskIds: readonly string[]) {
  return q
    .selectFrom('tasks as g')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('g.workspace_id', '=', workspaceId)
    .where('g.tray', '=', 'inbox')
    .where('g.deleted_at', 'is', null)
    .where('g.id', 'in', jsonList(taskIds));
}

export const inboxToBacklogOperation = implement(inboxToBacklog, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskIds = input.items.map((item) => item.task_id);
  const count = taskIds.length;

  // 選んだタスクを読む。このワークスペースに無いもの（別の組織、別のワークスペース、削除済みを含む）が1件でもあれば 404
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .innerJoin('workspaces as w', 'w.id', 'tasks.workspace_id')
        .select(['tasks.id', 'tasks.tray', 'tasks.repository_id', 'tasks.created_at'])
        .where('w.organization_id', '=', organizationId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.deleted_at', 'is', null)
        .where('tasks.id', 'in', jsonList(taskIds)),
    ),
  );
  if (rows.length !== count) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  await throwIfClosed(db, workspaceId);
  if (rows.some((row) => row.tray !== 'inbox')) throw new ApiError(409, 'conflict', { reason: 'not_in_inbox' });

  // 振るリポジトリを読む（同じワークスペースの削除していないもの。無ければ 404）。今と同じなら書かない
  const current = new Map(rows.map((row) => [row.id, row.repository_id]));
  const repositoryChanges: { taskId: string; before: string | null; after: string }[] = [];
  const repositoryNames = new Map<string, string>();
  for (const item of input.items) {
    if (item.repository_id === undefined) continue;
    const before = current.get(item.task_id) ?? null;
    if (before === item.repository_id) continue;
    repositoryChanges.push({ taskId: item.task_id, before, after: item.repository_id });
  }
  const wanted = [
    ...new Set(repositoryChanges.flatMap((change) => [change.after, ...(change.before ? [change.before] : [])])),
  ];
  if (wanted.length > 0) {
    const names = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('repositories')
          .select(['repositories.id', 'repositories.name', 'repositories.deleted_at'])
          .where('repositories.workspace_id', '=', workspaceId)
          .where('repositories.id', 'in', jsonList(wanted)),
      ),
    );
    for (const row of names) repositoryNames.set(row.id, row.name);
    for (const change of repositoryChanges) {
      const live = names.find((row) => row.id === change.after && row.deleted_at === null);
      if (live === undefined) throw new ApiError(404, 'not_found');
    }
  }

  const at = now();
  const movedAt = at.toISOString();
  const guard = (q: From) => allInInbox(q, workspaceId, taskIds);
  // リポジトリを振る行が、振った後の値になっている、という条件。リポジトリの UPDATE が競合で 0 行になったとき、
  // 移す文も通さず、選んだリポジトリが付かないまま移した成功を返さない
  const repositoriesApplied = (q: From) =>
    q
      .selectFrom('tasks as r')
      .innerJoin(
        jsonPairRows(repositoryChanges.map((change) => [change.taskId, change.after] as const)).as('p'),
        'p.id',
        'r.id',
      )
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('r.workspace_id', '=', workspaceId)
      .whereRef('r.repository_id', '=', 'p.pos');

  const repositoryStatements = repositoryChanges.flatMap((change) => [
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ repository_id: change.after, updated_at: movedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', change.taskId),
            eb('workspace_id', '=', workspaceId),
            eb('repository_id', 'is', change.before),
            eb.exists(repositoryRow(q, workspaceId, change.after).select('repositories.id')),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb(eb.selectFrom(guard(q).as('c')).select('c.n'), '=', count),
          ]),
        ),
    ),
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(change.taskId).as('entity_id'),
              eb.val('update').as('action'),
              eb
                .val(
                  JSON.stringify({
                    repository: [
                      refOf(change.before, change.before === null ? null : repositoryNames.get(change.before)),
                      refOf(change.after, repositoryNames.get(change.after)),
                    ],
                  }),
                )
                .as('changes_json'),
              eb.val(movedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  const results = await db.batch([
    ...repositoryStatements,
    // 移す履歴を先に置く（移した後は、受信箱の条件に当たらなくなるため）
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.ref('t.id').as('entity_id'),
              eb.val('update').as('action'),
              eb.val(JSON.stringify({ tray: ['inbox', 'backlog'] })).as('changes_json'),
              eb.val(movedAt).as('created_at'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where('t.id', 'in', jsonList(taskIds))
            .where((eb) =>
              eb.and([
                eb.exists(openWorkspace(q, organizationId, workspaceId)),
                eb(eb.selectFrom(guard(q).as('c')).select('c.n'), '=', count),
                ...(repositoryChanges.length === 0
                  ? []
                  : [eb(eb.selectFrom(repositoriesApplied(q).as('a')).select('a.n'), '=', repositoryChanges.length)]),
              ]),
            ),
        ),
    ),
    // バックログの親のない末尾に、届いた順（古い順）のまま振る
    db.statement((q) =>
      q
        .updateTable('tasks')
        .from(
          q
            .selectFrom('tasks as t')
            .select((eb) => [
              't.id as id',
              tailPosition(
                lastTaskPosition(q, workspaceId, 'backlog'),
                eb.fn.agg<number>('row_number').over((ob) => ob.orderBy('t.created_at').orderBy('t.id')),
                eb.fn.countAll<number>().over(),
              ).as('position'),
            ])
            .where('t.workspace_id', '=', workspaceId)
            .where('t.id', 'in', jsonList(taskIds))
            .where((eb) =>
              eb.and([
                eb.exists(openWorkspace(q, organizationId, workspaceId)),
                eb(eb.selectFrom(guard(q).as('c')).select('c.n'), '=', count),
                ...(repositoryChanges.length === 0
                  ? []
                  : [eb(eb.selectFrom(repositoriesApplied(q).as('a')).select('a.n'), '=', repositoryChanges.length)]),
              ]),
            )
            .as('n'),
        )
        .set((eb) => ({
          tray: 'backlog',
          story_id: null,
          sprint_id: null,
          column_id: null,
          column_position: null,
          position: eb.ref('n.position'),
          updated_at: movedAt,
        }))
        .whereRef('tasks.id', '=', 'n.id')
        .where('tasks.workspace_id', '=', workspaceId),
    ),
  ]);

  const moved = results.at(-1)?.changes ?? 0;
  if (moved !== count) {
    // 閉じていれば 409 の workspace_closed。そうでなければ、読んでから書くまでに別の要求が動かしたので、何も書かれていない
    await throwIfClosed(db, workspaceId);
    throw new ApiError(409, 'conflict');
  }
  return { moved };
});
