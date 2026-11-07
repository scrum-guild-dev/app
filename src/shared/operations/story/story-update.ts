import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema, storyTitleSchema } from '../../story.ts';
import { defineOperation } from '../define.ts';
import { storyDetailSchema } from './story.ts';

// ストーリーの欄を変える。送られた欄のうち、今の値と違うものだけを書く（送られない欄は触らない）。
// 引き出しを開いたときの値から変えた欄だけを送ると、別の人が別の欄を直していても両方が残り、同じ欄は後の保存が勝つ。
// 変わる欄が無ければ何も書かない（履歴も残さない）。無いストーリー（別の組織・別のワークスペース・削除済みを含む）は 404。
// 書き始める前の値（expected）は任意。引き出しの自動保存が、欄を書き始めたときの値を添える。書く欄（今の値と違うもの）のうち、
// 添えられた欄の値がサーバーの今の値と違えば、何も書かず 409 の conflict（details.reason は stale、details.current は今の値）で断る。
// 添えない呼び出し（CLI、MCP）は今のまま、後の保存が勝つ。
// 続けて直した分は履歴を1行にまとめる: 同じ人が、直前の履歴の行（同じ欄だけを直した行）の数分以内に、同じ欄だけを直すと、行を足さずに「後」の値を書き換える（「前」は最初の行のまま）。
// 書く文は「読んだ値のままなら」という条件つきで、別の要求が先に同じ欄を変えていたら、読み直してやり直す（3 回まで。超えたら 409 の conflict）。
// 区分（category_id）は親のないストーリーだけが持つ。エピックの下のストーリーへ送ると 409 の conflict（has_parent）、
// 同じワークスペースの削除していない区分でなければ 404。
// 返すのは、書いた後に読み直した値
export const storyUpdate = defineOperation({
  name: 'story-update',
  description:
    'ストーリーのタイトル、受け入れ基準、本文、期日、リンク、区分（親のないものだけ）のうち、送った欄だけを変える。変わる欄が無ければ何も書かない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    story_id: idSchema,
    expected: z
      .object({
        title: storyTitleSchema.optional(),
        acceptance_criteria_md: longTextSchema.optional(),
        body_md: longTextSchema.optional(),
        due_on: dueOnSchema.optional(),
        link_url: linkUrlSchema.optional(),
      })
      .optional(),
    title: storyTitleSchema.optional(),
    acceptance_criteria_md: longTextSchema.optional(),
    body_md: longTextSchema.optional(),
    due_on: dueOnSchema.optional(),
    link_url: linkUrlSchema.optional(),
    category_id: idSchema.nullable().optional(),
  }),
  output: z.object({ story: storyDetailSchema }),
});
