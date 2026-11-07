// 削除したタスクを戻す（task-restore）。docs/data-model.md の「書き込みの単位」の「タスクの削除の取り消し」
import { now } from '../../shared/clock.ts';
import { taskRestore, type TaskRestoreConflictReason } from '../../shared/operations/task/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import {
  activeMemberName,
  actorUserIdOf,
  changeLogColumns,
  mayDeleteOwned,
  openWorkspace,
  throwIfClosed,
} from './write-guards.ts';

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

// 削除を含めて、ワークスペースの中のタスクを読む。親のストーリー、区分、リポジトリは同じワークスペースのものだけを結ぶ
async function readDeletable(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('stories', (join) =>
          join.onRef('stories.id', '=', 'tasks.story_id').on('stories.workspace_id', '=', workspaceId),
        )
        .leftJoin('categories as live_category', (join) =>
          join
            .onRef('live_category.id', '=', 'tasks.category_id')
            .on('live_category.workspace_id', '=', workspaceId)
            .on('live_category.deleted_at', 'is', null),
        )
        .leftJoin('repositories as live_repository', (join) =>
          join
            .onRef('live_repository.id', '=', 'tasks.repository_id')
            .on('live_repository.workspace_id', '=', workspaceId)
            .on('live_repository.deleted_at', 'is', null),
        )
        .select([
          'tasks.created_by',
          'tasks.deleted_at',
          'tasks.completed_at',
          'tasks.story_id',
          'tasks.assignee_user_id',
          'tasks.today_on',
          'tasks.category_id',
          'tasks.repository_id',
          'stories.id as story_row_id',
          'stories.deleted_at as story_deleted_at',
          'stories.completed_at as story_completed_at',
          'live_category.id as live_category_id',
          'live_repository.id as live_repository_id',
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
  const deletedAtRead = task.deleted_at;
  if (!mayDeleteOwned(task.created_by, actor, workspace)) {
    // 作った人でもリーダーでもなくても、今の削除を書いた本人は戻せる（リーダーだった人が、削除した後に外れた場合など）。
    // 前に削除して戻された分ではなく、今の deleted_at を書いた削除の履歴だけを見る
    const deleter =
      deletedAtRead === null
        ? undefined
        : await db.first(
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
  if (deletedAtRead === null) throw new ApiError(409, 'conflict', { reason: 'not_deleted' });

  // 削除の間に変わった参照は、戻すときに外す。親が削除されたストーリーは親なし、所属を外れた担当は担当なし
  // （今日やるの印も外す）、削除された区分とリポジトリは空にする。外した分は履歴に残す
  const parentDeleted = task.story_row_id !== null && task.story_deleted_at !== null;
  const assigneeGone =
    task.assignee_user_id !== null &&
    (await db.first(
      db.statement((q) => activeMemberName(q, organizationId, workspaceId, task.assignee_user_id as string)),
    )) === undefined;
  const nextStoryId = parentDeleted ? null : task.story_id;
  const nextAssignee = assigneeGone ? null : task.assignee_user_id;
  const nextTodayOn = assigneeGone ? null : task.today_on;
  const categoryGone = task.category_id !== null && task.live_category_id === null;
  const repositoryGone = task.repository_id !== null && task.live_repository_id === null;
  const nextCategory = categoryGone ? null : task.category_id;
  const nextRepository = repositoryGone ? null : task.repository_id;
  const changes: Record<string, readonly [unknown, unknown]> = {
    deleted_at: [deletedAtRead, null],
    ...(parentDeleted ? { story_id: [task.story_id, null] } : {}),
    ...(assigneeGone ? { assignee_user_id: [task.assignee_user_id, null] } : {}),
    ...(assigneeGone && task.today_on !== null ? { today_on: [task.today_on, null] } : {}),
    ...(categoryGone ? { category_id: [task.category_id, null] } : {}),
    ...(repositoryGone ? { repository_id: [task.repository_id, null] } : {}),
  };

  const at = now();
  const restoredAt = at.toISOString();
  const results = await db.batch([
    // 読んだ削除（deleted_at が読んだ値）だけを戻す。親の条件は読んでから書くまでに変わりうるので、書く文にも入れる
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({
          deleted_at: null,
          updated_at: restoredAt,
          story_id: nextStoryId,
          assignee_user_id: nextAssignee,
          today_on: nextTodayOn,
          category_id: nextCategory,
          repository_id: nextRepository,
        })
        .where((eb) =>
          eb.and([
            eb('id', '=', taskId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', '=', deletedAtRead),
            task.story_id === null ? eb('story_id', 'is', null) : eb('story_id', '=', task.story_id),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
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
    // 読んでから書くまでに、閉じたか、別の要求が先に戻したか、消し直したか、親が変わった。読み直して理由を返す
    await throwIfClosed(db, workspaceId);
    const current = await readDeletable(db, workspaceId, taskId);
    if (current === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict', { reason: blockOf(current) ?? 'changed' });
  }
  return { task_id: taskId };
});
