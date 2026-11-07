// 削除したタスクを戻す（task-restore）。docs/data-model.md の「書き込みの単位」の「タスクの削除の取り消し」
import { now } from '../../shared/clock.ts';
import { taskRestore, type TaskRestoreConflictReason } from '../../shared/operations/task/index.ts';
import { previousStatementChanged, tailPosition, unindexed, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, mayDeleteOwned, openWorkspace, throwIfClosed } from './write-guards.ts';

// 戻せない理由。戻せるなら null。親のストーリーが削除されているときは断らず、親なしで戻す
export function restoreBlockOf(state: {
  deletedAt: string | null;
  completedAt: string | null;
  storyDeletedAt: string | null;
  storyCompletedAt: string | null;
  hasStory: boolean;
}): TaskRestoreConflictReason | null {
  if (state.deletedAt === null) return 'not_deleted';
  if (state.hasStory && state.storyDeletedAt !== null) return null;
  // 完了したストーリーの下に完了していないタスクを置かない（完了したタスクはそのまま戻せる）
  if (state.hasStory && state.storyCompletedAt !== null && state.completedAt === null) return 'parent_completed';
  return null;
}

// 削除を含めて、ワークスペースの中のタスクを読む。親のストーリー、担当、区分、リポジトリは、同じ組織とワークスペースのものだけを結ぶ
async function readDeletable(db: OrganizationDb, workspaceId: string, taskId: string) {
  const organizationId = db.organizationId;
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('stories', (join) =>
          join.onRef('stories.id', '=', 'tasks.story_id').on('stories.workspace_id', '=', workspaceId),
        )
        .leftJoin('users as assignee', (join) =>
          join.onRef('assignee.id', '=', 'tasks.assignee_user_id').on('assignee.organization_id', '=', organizationId),
        )
        .leftJoin('categories as cat', (join) =>
          join.onRef('cat.id', '=', 'tasks.category_id').on('cat.workspace_id', '=', workspaceId),
        )
        .leftJoin('repositories as repo', (join) =>
          join.onRef('repo.id', '=', 'tasks.repository_id').on('repo.workspace_id', '=', workspaceId),
        )
        .select([
          'tasks.created_by',
          'tasks.deleted_at',
          'tasks.completed_at',
          'tasks.story_id',
          'tasks.position',
          'tasks.assignee_user_id',
          'tasks.today_on',
          'tasks.category_id',
          'tasks.repository_id',
          'stories.id as story_row_id',
          'stories.title as story_title',
          'stories.deleted_at as story_deleted_at',
          'stories.completed_at as story_completed_at',
          'assignee.name as assignee_name',
          'cat.name as category_name',
          'cat.deleted_at as category_deleted_at',
          'repo.name as repository_name',
          'repo.deleted_at as repository_deleted_at',
        ])
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId),
    ),
  );
}

type Readout = NonNullable<Awaited<ReturnType<typeof readDeletable>>>;

function blockOf(row: Readout): TaskRestoreConflictReason | null {
  return restoreBlockOf({
    deletedAt: row.deleted_at,
    completedAt: row.completed_at,
    storyDeletedAt: row.story_deleted_at,
    storyCompletedAt: row.story_completed_at,
    hasStory: row.story_row_id !== null,
  });
}

// 履歴の値は、task-update と同じ {id, name}
const refOf = (id: string, name: string | null) => ({ id, name: name ?? '' });

export const taskRestoreOperation = implement(taskRestore, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;

  const task = await readDeletable(db, workspaceId, taskId);
  if (task === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  // 削除していないタスクは、権限より先に 409（戻した後の再送が 403 にならないように）
  const deletedAtRead = task.deleted_at;
  if (deletedAtRead === null) throw new ApiError(409, 'conflict', { reason: 'not_deleted' });
  if (!mayDeleteOwned(task.created_by, actor, workspace)) {
    // 作った人でもリーダーでもなくても、今の削除を書いた本人は戻せる（リーダーだった人が、削除した後に外れた場合など）。
    // 前に削除して戻された分ではなく、今の deleted_at を書いた削除の履歴だけを見る
    const deleter = await db.first(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('change_logs.actor_user_id')
          .where('change_logs.organization_id', '=', organizationId)
          .where('change_logs.workspace_id', '=', workspaceId)
          .where('change_logs.entity_type', '=', 'task')
          .where('change_logs.entity_id', '=', taskId)
          .where('change_logs.action', '=', 'delete')
          .where('change_logs.created_at', '=', deletedAtRead)
          .orderBy('change_logs.id', 'desc')
          .limit(1),
      ),
    );
    if (deleter?.actor_user_id !== actorUserId) throw new ApiError(403, 'forbidden');
  }
  const reason = blockOf(task);
  if (reason !== null) throw new ApiError(409, 'conflict', { reason });

  // 削除の間に変わった参照は、戻すときに外す。親が削除されたストーリーは親なし（並びは親なしの末尾）、
  // 所属を外れた担当は担当なし（今日やるの印も外す）、削除された区分とリポジトリは空にする。外した分は履歴に残す。
  // 退会が担当を外すのは完了していないタスクだけなので、完了したタスクの担当は、所属を外れていても替えない
  const completed = task.completed_at !== null;
  const parentDeleted = task.story_row_id !== null && task.story_deleted_at !== null;
  const assigneeId = task.assignee_user_id;
  const assigneeActive =
    assigneeId === null
      ? true
      : (await db.first(
          db.statement((q) =>
            q
              .selectFrom('memberships as m')
              .select('m.user_id')
              .where('m.workspace_id', '=', workspaceId)
              .where('m.user_id', '=', assigneeId)
              .where('m.left_at', 'is', null),
          ),
        )) !== undefined;
  const assigneeGone = assigneeId !== null && !completed && !assigneeActive;
  const categoryGone = task.category_id !== null && task.category_deleted_at !== null;
  const repositoryGone = task.repository_id !== null && task.repository_deleted_at !== null;
  const nextStoryId = parentDeleted ? null : task.story_id;
  const changes: Record<string, readonly [unknown, unknown]> = {
    deleted_at: [deletedAtRead, null],
    ...(parentDeleted && task.story_id !== null ? { story: [refOf(task.story_id, task.story_title), null] } : {}),
    ...(assigneeGone && assigneeId !== null ? { assignee: [refOf(assigneeId, task.assignee_name), null] } : {}),
    ...(assigneeGone && task.today_on !== null ? { today_on: [task.today_on, null] } : {}),
    ...(categoryGone && task.category_id !== null
      ? { category: [refOf(task.category_id, task.category_name), null] }
      : {}),
    ...(repositoryGone && task.repository_id !== null
      ? { repository: [refOf(task.repository_id, task.repository_name), null] }
      : {}),
  };

  const at = now();
  const restoredAt = at.toISOString();
  const results = await db.batch([
    // 読んだ削除（deleted_at が読んだ値）だけを戻す。親と参照は読んでから書くまでに変わりうるので、書く文にも条件を入れる。
    // 外す参照は読んだ値と同じこと、残す参照は今も有効なことが条件。ずれたら 0 行で、読み直して 409（changed か理由）
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set((eb) => ({
          deleted_at: null,
          updated_at: restoredAt,
          story_id: nextStoryId,
          // 親なしで戻すときは、親なしの並びの末尾に置く（元の親の中の値のままだと、親なしの並びの途中に割り込む）
          ...(parentDeleted
            ? {
                position: tailPosition(
                  eb
                    .selectFrom('tasks')
                    .select('tasks.position')
                    .where('tasks.workspace_id', '=', workspaceId)
                    .where('tasks.tray', '=', 'backlog')
                    .where('tasks.deleted_at', 'is', null)
                    .where(unindexed('tasks.story_id'), 'is', null)
                    .orderBy('tasks.position', 'desc')
                    .limit(1),
                  eb.val('1'),
                  eb.val('1'),
                ),
              }
            : {}),
          ...(assigneeGone ? { assignee_user_id: null, today_on: null } : {}),
          ...(categoryGone ? { category_id: null } : {}),
          ...(repositoryGone ? { repository_id: null } : {}),
        }))
        .where((eb) =>
          eb.and([
            eb('id', '=', taskId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', '=', deletedAtRead),
            task.story_id === null ? eb('story_id', 'is', null) : eb('story_id', '=', task.story_id),
            assigneeId === null ? eb('assignee_user_id', 'is', null) : eb('assignee_user_id', '=', assigneeId),
            task.category_id === null ? eb('category_id', 'is', null) : eb('category_id', '=', task.category_id),
            task.repository_id === null
              ? eb('repository_id', 'is', null)
              : eb('repository_id', '=', task.repository_id),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            // 残す担当は今も所属している（完了したタスクは確かめない）
            assigneeId === null || assigneeGone || completed
              ? eb.val(true)
              : eb.exists(
                  eb
                    .selectFrom('memberships as m')
                    .select('m.user_id')
                    .whereRef('m.user_id', '=', 'tasks.assignee_user_id')
                    .where('m.workspace_id', '=', workspaceId)
                    .where('m.left_at', 'is', null),
                ),
            task.category_id === null || categoryGone
              ? eb.val(true)
              : eb.exists(
                  eb
                    .selectFrom('categories as c')
                    .select('c.id')
                    .whereRef('c.id', '=', 'tasks.category_id')
                    .where('c.workspace_id', '=', workspaceId)
                    .where('c.deleted_at', 'is', null),
                ),
            task.repository_id === null || repositoryGone
              ? eb.val(true)
              : eb.exists(
                  eb
                    .selectFrom('repositories as r')
                    .select('r.id')
                    .whereRef('r.id', '=', 'tasks.repository_id')
                    .where('r.workspace_id', '=', workspaceId)
                    .where('r.deleted_at', 'is', null),
                ),
            task.story_id === null
              ? eb.val(true)
              : eb.exists(
                  eb
                    .selectFrom('stories as parent')
                    .select('parent.id')
                    .whereRef('parent.id', '=', 'tasks.story_id')
                    .where('parent.workspace_id', '=', workspaceId)
                    .$if(parentDeleted, (qb) => qb.where('parent.deleted_at', 'is not', null))
                    .$if(!parentDeleted, (qb) =>
                      qb
                        .where('parent.deleted_at', 'is', null)
                        .where((pb) =>
                          pb.or([pb('parent.completed_at', 'is', null), pb('tasks.completed_at', 'is not', null)]),
                        ),
                    ),
                ),
          ]),
        ),
    ),
    // 直前の更新が行を変えたときだけ履歴を書く
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
              eb.val(taskId).as('entity_id'),
              eb.val('restore').as('action'),
              eb.val(JSON.stringify(changes)).as('changes_json'),
              eb.val(restoredAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、別の要求が先に戻したか、消し直したか、親や参照が変わった。読み直して理由を返す
    await throwIfClosed(db, workspaceId);
    const current = await readDeletable(db, workspaceId, taskId);
    if (current === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict', { reason: blockOf(current) ?? 'changed' });
  }
  return { task_id: taskId };
});
