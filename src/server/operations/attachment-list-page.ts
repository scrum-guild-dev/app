// タスクの確定した添付を、日時と ID の安定した順で50件ずつ読む。
import { ATTACHMENT_LIST_PAGE_SIZE, attachmentList } from '../../shared/operations/attachment/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { mayDeleteOwned } from './write-guards.ts';

export const attachmentListOperation = implement(attachmentList, async ({ db, workspace, actor, input }) => {
  const task = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select('id')
        .where('workspace_id', '=', workspace.workspaceId)
        .where('id', '=', input.task_id)
        .where('deleted_at', 'is', null),
    ),
  );
  if (task === undefined) throw new ApiError(404, 'not_found');
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
        .$if(input.after !== undefined, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('a.created_at', '>', input.after!.created_at),
              eb.and([eb('a.created_at', '=', input.after!.created_at), eb('a.id', '>', input.after!.id)]),
            ]),
          ),
        )
        .orderBy('a.created_at')
        .orderBy('a.id')
        .limit(ATTACHMENT_LIST_PAGE_SIZE + 1),
    ),
  );
  const attachments = rows.slice(0, ATTACHMENT_LIST_PAGE_SIZE).map((row) => ({
    ...row,
    deletable: !workspace.closed && mayDeleteOwned(row.uploaded_by, actor, workspace),
  }));
  const last = attachments.at(-1);
  return {
    attachments,
    ...(rows.length > ATTACHMENT_LIST_PAGE_SIZE && last !== undefined
      ? { next_cursor: { created_at: last.created_at, id: last.id } }
      : {}),
  };
});
