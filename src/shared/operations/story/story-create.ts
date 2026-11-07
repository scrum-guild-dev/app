import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { dueOnSchema, linkUrlSchema, longTextSchema, storyTitleSchema } from '../../story.ts';
import { defineOperation } from '../define.ts';
import { storyDetailSchema } from './story.ts';

// ストーリーを作る。親のエピックは epic_id で指す（任意）。同じワークスペースの削除していないエピックでなければ 404（別の組織も 404）、
// 完了か中止したエピックなら 409 の conflict（details.reason は parent_completed）。
// position は親の配下（親なしなら、親のないストーリー）の末尾。作った人（created_by）は呼んだ人。
// 区分（category_id）は親のないストーリーだけが持つ。親と一緒に送ると 409 の conflict（has_parent）で、エピックの下では親の区分を引き継ぐ。
// タイトル以外の欄は省略でき、空は null になる。区分（category_id）は、同じワークスペースの削除していない区分でなければ 404。
// 変更の履歴（entity_type = 'story'、create）も同時に書く
export const storyCreate = defineOperation({
  name: 'story-create',
  description:
    'ストーリーを作る。タイトル、親のエピック、受け入れ基準、本文、期日、リンク、区分（親のないときだけ）を指す（タイトル以外は任意）。位置は親の配下（親なしなら親のないストーリー）の末尾',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    title: storyTitleSchema,
    epic_id: idSchema.nullable().default(null),
    acceptance_criteria_md: longTextSchema.default(null),
    body_md: longTextSchema.default(null),
    due_on: dueOnSchema.default(null),
    link_url: linkUrlSchema.default(null),
    category_id: idSchema.nullable().default(null),
  }),
  output: z.object({ story: storyDetailSchema }),
});
