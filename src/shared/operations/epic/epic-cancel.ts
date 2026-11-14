import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 依頼主とリーダー（管理者を含む）だけ。別の組織・ワークスペース・削除済みは404、
// 権限不足は403、閉じたワークスペースは409 workspace_closed、クリア済みは409 epic_finished。
// 既に中止済みの中止、未中止の取り消し、書き込みの競合は409 conflict。
// 配下、討伐隊、経験値は変えず、中止日時・中止した人と履歴だけを同じbatchで書く。
export const epicCancel = defineOperation({
  name: 'epic-cancel',
  description: '依頼主とリーダーが、未クリアのエピックを中止する',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({ epic_id: z.string() }),
});

export const epicUncancel = defineOperation({
  name: 'epic-uncancel',
  description: '依頼主とリーダーが、エピックの中止を取り消す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({ epic_id: z.string() }),
});
