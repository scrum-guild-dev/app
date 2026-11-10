import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { epicDetailSchema } from './epic.ts';

// エピックのダイアログを開くときに、エピック1件の全部の欄を読む。本文は長い（1 万字まで）ので、バックログの木には載せない。
// 閉じたワークスペースでも読める。無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404。
// 削除のボタンと確認のために、呼んだ人が削除できるか（作った人かリーダー。管理者を含む）と、配下の削除していない
// ストーリーとタスク（その下のタスク。完了したものも含む）の件数も返す。
// completed_at は、エピックをクリアした日時（クリアしていなければ null）。削除の確認が、クリア済みで配下のあるエピックの
// 「配下を親なしで残す」を最初から選べなくするために読む（サーバーの断りは epic_finished のまま残る）。
// can_delete_children は、配下ごとまとめて削除（children: 'delete'）できるか。削除できて、リーダーか管理者か、
// 削除していない配下（ストーリーと、手で作ったタスク）がすべて呼んだ人の作ったもののとき真
export const epicGet = defineOperation({
  name: 'epic-get',
  description:
    'エピック1件のタイトル、本文、期日、リンクと、クリアした日時、削除できるか、まとめて削除できるか、配下の件数を返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({
    epic: epicDetailSchema,
    completed_at: z.string().nullable(),
    can_delete: z.boolean(),
    can_delete_children: z.boolean(),
    children: z.object({ stories: z.number().int(), tasks: z.number().int() }),
  }),
});
