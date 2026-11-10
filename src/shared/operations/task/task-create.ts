import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { longTextSchema } from '../../story.ts';
import { taskPointsSchema, taskTitleSchema } from '../../task.ts';
import { defineOperation } from '../define.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { backlogTaskSchema } from './backlog-tree.ts';

// 入れ先を付けた作成を 409 の conflict で断った理由（details.reason）。closed は終了したスプリントへ入れようとした、
// done_column は完了の列へ入れようとした。親のストーリーが完了していたときの conflict は理由を持たない
export const taskCreateConflictReasons = ['closed', 'done_column'] as const;
export type TaskCreateConflictReason = (typeof taskCreateConflictReasons)[number];

export function taskCreateConflictReasonOf(details: unknown): TaskCreateConflictReason | undefined {
  return conflictReasonOf(details, taskCreateConflictReasons);
}

// 手でタスクを作る。置き場所はバックログ（tray = 'backlog'）。
// 親は story_id で指す。同じワークスペースの、削除していないストーリーでなければ 404、完了したストーリーなら 409 の conflict。
// position は親の配下の末尾（親なしなら、親のないタスクの末尾）。
// 作った人（created_by）は呼んだ人。担当はそのワークスペースに今所属している人だけで、そうでなければ存在しないときと同じ 404。
// 区分（category_id）は親のないタスクだけが持つ。親と一緒に送ると 409 の conflict（has_parent）。区分とリポジトリ（repository_id）は、
// 同じワークスペースの削除していないものでなければ 404（別の組織も 404）。
// 経験値は作ったときには付かず、完了にした時点で（ポイントが 1 以上なら）付く。
// 入れる先（sprint）を送ると、作ったタスクをそのスプリントのその列の末尾に入れる（スプリントの画面の列の末尾の空の行）。
// 作成、スプリントへの入れ込み（sprint_entries）、変更の履歴は同じ batch() で書き、入れ込みが断られたときはタスクも作られない。
// スプリントは同じワークスペースの削除していない、始まっていないか進行中のものでなければ 404（別の組織も 404）、終了したものなら
// 409 の conflict（reason は closed）。列は同じワークスペースの削除していないものでなければ 404、完了の列なら 409 の conflict
// （reason は done_column。完了にするのは task-complete）。位置はその列の中の末尾。置き場所は入れ先に関わらず、バックログ（tray = 'backlog'）
export const taskCreate = defineOperation({
  name: 'task-create',
  description:
    'バックログにタスクを作る。タイトル、本文（任意、1万字まで）、ポイント（未設定か 0、1、2、3、5、8、13）、担当（任意）、親のストーリー（任意）、リポジトリ（任意）、区分（親のないときだけ、任意）を指す。位置は親の配下の末尾。入れ先のスプリントと列（任意、完了の列は不可）を指すと、同時にその列の末尾に入れる',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    title: taskTitleSchema,
    body_md: longTextSchema.default(null),
    points: taskPointsSchema.nullable().default(null),
    assignee_user_id: idSchema.nullable().default(null),
    story_id: idSchema.nullable().default(null),
    repository_id: idSchema.nullable().default(null),
    category_id: idSchema.nullable().default(null),
    sprint: z.object({ sprint_id: idSchema, column_id: idSchema }).nullable().default(null),
  }),
  output: z.object({ task: backlogTaskSchema }),
});
