import type { OrganizationDb, AttachmentSave } from '../db/index.ts';
import { ApiError } from '../errors.ts';

export async function checkAttachments(db: OrganizationDb, save: AttachmentSave): Promise<void> {
  if (save.ids.length === 0) return;
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('attachments')
        .select(['id', 'uploaded_by', 'attached_at'])
        .where('workspace_id', '=', save.workspaceId)
        .where('id', 'in', save.ids),
    ),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = save.ids.filter((id) => {
    const row = byId.get(id);
    return row === undefined || (row.attached_at === null && row.uploaded_by !== save.userId);
  });
  if (missing.length > 0) throw new ApiError(404, 'not_found', { attachment_ids: missing });
  const attached = save.ids.filter((id) => byId.get(id)?.attached_at !== null);
  if (attached.length > 0)
    throw new ApiError(409, 'conflict', { reason: 'attachment_attached', attachment_ids: attached });
}

export function attachmentChanges(ids: readonly string[]) {
  return ids.length === 0 ? {} : { attachments: [null, ids.map((id) => ({ id }))] };
}
