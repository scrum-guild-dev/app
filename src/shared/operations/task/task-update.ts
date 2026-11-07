import { z } from 'zod';
import { attachmentIdsSchema } from '../../attachment.ts';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema } from '../../story.ts';
import { taskPointsSchema, taskTitleSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';
import { taskDetailSchema } from './task.ts';

// タスクの欄を変える。送られた欄のうち、今の値と違うものだけを書く（送られない欄は触らない）。
// 引き出しを開いたときの値から変えた欄だけを送ると、別の人が別の欄を直していても両方が残り、同じ欄は後の保存が勝つ。
// 変わる欄が無ければ何も書かない（履歴も残さない）。無いタスク（別の組織・別のワークスペース・削除済みを含む）は 404。
// 断る変更は 409 の conflict:
//   - 完了したタスクのポイント（経験値とスプリントの集計が、完了の記録の値を使うため）
//   - 取り込んだタスクのタイトルとリンク（タイトルは同期で書き直し、リンクは手で作ったタスクだけが持つ）
// 書き始める前の値（expected）は任意。引き出しの自動保存が、欄を書き始めたときの値を添える。書く欄（今の値と違うもの）のうち、
// 添えられた欄の値がサーバーの今の値と違えば、何も書かず 409 の conflict（details.reason は stale、details.current は今の値）で断る。
// 添えない呼び出し（CLI、MCP）は今のまま、後の保存が勝つ。
// 続けて直した分は履歴を1行にまとめる: 同じ人が、直前の履歴の行（同じ欄だけを直した行）の数分以内に、同じ欄だけを直すと、行を足さずに「後」の値を書き換える（「前」は最初の行のまま）。
// 書く文は「読んだ値のままなら」という条件つきで、別の要求が先に同じ欄を変えていたら、読み直してやり直す（3 回まで。超えたら 409 の conflict）。
//   - 親のあるタスクの区分（details.reason は has_parent。区分は親から引き継ぐ）
// 区分（category_id）とリポジトリ（repository_id）は、同じワークスペースの削除していないものでなければ 404。
// 担当（task-assign）は、この操作では変えない。返すのは、書いた後に読み直した値
export const taskUpdate = defineOperation({
  name: 'task-update',
  description:
    'タスクのタイトル、ポイント、期日、リンク、本文、リポジトリ、区分（親のないタスクだけ）のうち、送った欄だけを変える。変わる欄が無ければ何も書かない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    task_id: idSchema,
    attachment_ids: attachmentIdsSchema.optional(),
    expected: z
      .object({
        title: taskTitleSchema.optional(),
        points: taskPointsSchema.nullable().optional(),
        due_on: dueOnSchema.optional(),
        link_url: linkUrlSchema.optional(),
        body_md: longTextSchema.optional(),
      })
      .optional(),
    title: taskTitleSchema.optional(),
    points: taskPointsSchema.nullable().optional(),
    due_on: dueOnSchema.optional(),
    link_url: linkUrlSchema.optional(),
    body_md: longTextSchema.optional(),
    repository_id: idSchema.nullable().optional(),
    category_id: idSchema.nullable().optional(),
  }),
  output: z.object({ task: taskDetailSchema }),
});
