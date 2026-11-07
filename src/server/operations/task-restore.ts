// 削除したタスクを戻す（task-restore）。docs/data-model.md の「書き込みの単位」の「タスクの削除の取り消し」
import { now } from '../../shared/clock.ts';
import { taskRestore, type TaskRestoreConflictReason } from '../../shared/operations/task/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, mayDeleteOwned, openWorkspace, throwIfClosed } from './write-guards.ts';

// 戻せない理由。戻せるなら null
export function restoreBlockOf(state: {
  deletedAt: string | null;
  completedAt: string | null;
  storyDeletedAt: string | null;
  storyCompletedAt: string | null;
  hasStory: boolean;
}): TaskRestoreConflictReason | null {
  if (state.deletedAt === null) return 'not_deleted';
  if (state.hasStory && state.storyDeletedAt !== null) return 'parent_deleted';
  // 完了したストーリーの下に完了していないタスクを置かない（完了したタスクはそのまま戻せる）
  if (state.hasStory && state.storyCompletedAt !== null && state.completedAt === null) return 'parent_completed';
  return null;
}

// 削除を含めて、ワークスペースの中のタスクを読む。親のストーリーは同じワークスペースのものだけを結ぶ
async function readDeletable(db: OrganizationDb, workspaceId: string, taskId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .leftJoin('stories', (join) =>
          join.onRef('stories.id', '=', 'tasks.story_id').on('stories.workspace_id', '=', workspaceId),
        )
        .select([
          'tasks.created_by',
          'tasks.deleted_at',
          'tasks.completed_at',
          'tasks.story_id',
          'stories.id as story_row_id',
          'stories.deleted_at as story_deleted_at',
          'stories.completed_at as story_completed_at',
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
  if (!mayDeleteOwned(task.created_by, actor, workspace)) {
    // 作った人でもリーダーでもなくても、削除した本人は戻せる（リーダーだった人が、削除した後に外れた場合など）
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
          .orderBy('change_logs.created_at', 'desc')
          .orderBy('change_logs.id', 'desc')
          .limit(1),
      ),
    );
    if (deleter?.actor_user_id !== actorUserId) throw new ApiError(403, 'forbidden');
  }
  const reason = blockOf(task);
  if (reason !== null) throw new ApiError(409, 'conflict', { reason });
  const deletedAtRead = task.deleted_at;

  const at = now();
  const restoredAt = at.toISOString();
  const results = await db.batch([
    // 読んだ削除（deleted_at が読んだ値）だけを戻す。親の条件は読んでから書くまでに変わりうるので、書く文にも入れる
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ deleted_at: null, updated_at: restoredAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', taskId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', '=', deletedAtRead),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            eb.or([
              eb('story_id', 'is', null),
              eb.exists(
                eb
                  .selectFrom('stories as parent')
                  .select('parent.id')
                  .whereRef('parent.id', '=', 'tasks.story_id')
                  .where('parent.workspace_id', '=', workspaceId)
                  .where('parent.deleted_at', 'is', null)
                  .where((pb) =>
                    pb.or([pb('parent.completed_at', 'is', null), pb('tasks.completed_at', 'is not', null)]),
                  ),
              ),
            ]),
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
              eb.val(JSON.stringify({ deleted_at: [deletedAtRead, null] })).as('changes_json'),
              eb.val(restoredAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、別の要求が先に戻したか、親が変わった。読み直して理由を返す
    await throwIfClosed(db, workspaceId);
    const current = await readDeletable(db, workspaceId, taskId);
    if (current === undefined) throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict', { reason: blockOf(current) ?? 'not_deleted' });
  }
  return { task_id: taskId };
});
