// タスクに確定した添付の一覧と削除。別の付く先や未添付は扱わない。
import { attachmentList, attachmentDelete } from '../../shared/operations/attachment/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { now } from '../../shared/clock.ts';
import { uuidv7 } from '../uuid.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, mayDeleteOwned, openWorkspace, throwIfClosed } from './write-guards.ts';

async function requireTask(db: OrganizationDb, workspaceId: string, taskId: string): Promise<void> {
  const task = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', taskId)
        .where('deleted_at', 'is', null),
    ),
  );
  if (task === undefined) throw new ApiError(404, 'not_found');
}

export const attachmentListOperation = implement(attachmentList, async ({ db, workspace, actor, input }) => {
  await requireTask(db, workspace.workspaceId, input.task_id);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('attachments as a')
        .leftJoin('users as u', (join) =>
          join.onRef('u.id', '=', 'a.uploaded_by').on('u.organization_id', '=', db.organizationId),
        )
        .select([
          'a.id',
          'a.file_name',
          'a.content_type',
          'a.size_bytes',
          'a.created_at',
          'a.uploaded_by',
          'u.name as uploaded_by_name',
        ])
        .where('a.workspace_id', '=', workspace.workspaceId)
        .where('a.task_id', '=', input.task_id)
        .where('a.attached_at', 'is not', null)
        .where('a.comment_id', 'is', null)
        .where('a.story_id', 'is', null)
        .where('a.epic_id', 'is', null)
        .orderBy('a.created_at')
        .orderBy('a.id'),
    ),
  );
  return {
    attachments: rows.map((row) => ({
      ...row,
      deletable: !workspace.closed && mayDeleteOwned(row.uploaded_by, actor, workspace),
    })),
  };
});

export const attachmentDeleteOperation = implement(
  attachmentDelete,
  async ({ db, workspace, actor, input, attachmentStorage }) => {
    const workspaceId = workspace.workspaceId;
    const userId = actorUserIdOf(actor);
    await requireTask(db, workspaceId, input.task_id);
    const row = await db.first(
      db.statement((q) =>
        q
          .selectFrom('attachments')
          .select(['id', 'uploaded_by', 'object_key'])
          .where('workspace_id', '=', workspaceId)
          .where('id', '=', input.attachment_id)
          .where('task_id', '=', input.task_id)
          .where('attached_at', 'is not', null)
          .where('comment_id', 'is', null)
          .where('story_id', 'is', null)
          .where('epic_id', 'is', null),
      ),
    );
    const key = `${db.organizationId}/${workspaceId}/${input.attachment_id}`;
    if (row === undefined || row.object_key !== key) throw new ApiError(404, 'not_found');
    if (!mayDeleteOwned(row.uploaded_by, actor, workspace)) throw new ApiError(403, 'forbidden');
    const at = now();
    const [deleted] = await db.batch([
      db.statement((q) =>
        q
          .deleteFrom('attachments')
          .where('workspace_id', '=', workspaceId)
          .where('id', '=', input.attachment_id)
          .where('object_key', '=', key)
          .where('task_id', '=', input.task_id)
          .where('attached_at', 'is not', null)
          .where('comment_id', 'is', null)
          .where('story_id', 'is', null)
          .where('epic_id', 'is', null)
          .where((eb) => eb.exists(openWorkspace(q, db.organizationId, workspaceId)))
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('tasks')
                .select('id')
                .where('id', '=', input.task_id)
                .where('workspace_id', '=', workspaceId)
                .where('deleted_at', 'is', null),
            ),
          )
          .where((eb) =>
            actor.isAdmin
              ? eb.val(true)
              : eb.exists(
                  eb
                    .selectFrom('memberships as m')
                    .select('m.id')
                    .where('m.workspace_id', '=', workspaceId)
                    .where('m.user_id', '=', userId)
                    .where('m.left_at', 'is', null)
                    .where((membership) =>
                      membership.or([
                        membership('m.role', '=', 'leader'),
                        membership('attachments.uploaded_by', '=', userId),
                      ]),
                    ),
                ),
          )
          .returning(['id', 'object_key']),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(uuidv7(at)).as('id'),
                eb.val(db.organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(userId).as('actor_user_id'),
                eb.val('attachment').as('entity_type'),
                eb.val(input.attachment_id).as('entity_id'),
                eb.val('delete').as('action'),
                eb.val(JSON.stringify({ task_id: [input.task_id, null] })).as('changes_json'),
                eb.val(at.toISOString()).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);
    const removed = deleted.rows[0];
    if (removed === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'conflict');
    }
    // D1 で実際に消したキーだけを消す。本文の参照は残し、以後の配信は404にする。
    try {
      await attachmentStorage.delete(removed.object_key);
    } catch {
      // D1 の削除は確定済み。後処理の失敗を操作の失敗にせず、秘密を含まない件数だけを記録する。
      console.error(JSON.stringify({ level: 'error', code: 'internal', operation: 'attachment-delete', count: 1 }));
    }
    return { id: removed.id };
  },
);
