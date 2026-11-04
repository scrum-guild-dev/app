import type { ExpressionBuilder } from 'kysely';
import type { OrganizationDb } from './entries.ts';
import type { OrganizationTables } from './tables.ts';
import { previousStatementChanged } from './previous-statement.ts';

export type AttachmentSave = { workspaceId: string; userId: string; ids: readonly string[] };

// 保存の主文にもこの件数を置き、読んだ後で掃除や別の保存が走っても全部か何もしないかにする。
export function attachmentsReady<DB, TB extends keyof DB>(builder: ExpressionBuilder<DB, TB>, save: AttachmentSave) {
  const eb = builder as unknown as ExpressionBuilder<OrganizationTables, never>;
  if (save.ids.length === 0) return eb.val(true);
  return eb(
    eb
      .selectFrom('attachments')
      .select((e) => e.fn.countAll<number>().as('count'))
      .where('id', 'in', save.ids)
      .where('workspace_id', '=', save.workspaceId)
      .where('uploaded_by', '=', save.userId)
      .where('attached_at', 'is', null),
    '=',
    save.ids.length,
  );
}

// 主文か、その成功だけに結ばれた履歴の直後に置く。同じ batch の中なので間に別の保存は入らない。
export function attachFilesStatement(
  db: OrganizationDb,
  save: AttachmentSave,
  target: { task_id: string } | { comment_id: string },
  at: string,
) {
  return db.statement((q) =>
    q
      .updateTable('attachments')
      .set({ ...target, attached_at: at })
      .where('id', 'in', save.ids)
      .where('workspace_id', '=', save.workspaceId)
      .where('uploaded_by', '=', save.userId)
      .where('attached_at', 'is', null)
      .where(previousStatementChanged),
  );
}
