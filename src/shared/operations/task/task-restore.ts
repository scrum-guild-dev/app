import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// タスクの削除を取り消すのを 409 の conflict で断った理由（details.reason）。
// not_deleted は削除していないタスクを戻そうとした（2つの画面から同時に戻した後の方を含む）、
// parent_completed は完了していないタスクを、完了したストーリーの下へ戻そうとした（ストーリーの完了を取り消してから戻す）、
// changed は読んでから書くまでに別の要求がタスクを変えた（消し直した、親が変わったなど）。
// 親のストーリーが削除されているときは断らず、親なしで戻す（ストーリーを戻す操作は無く、断ると二度と戻せないため）
export const taskRestoreConflictReasons = ['not_deleted', 'parent_completed', 'changed'] as const;
export type TaskRestoreConflictReason = (typeof taskRestoreConflictReasons)[number];

// 戻すときに外した参照（親、担当、区分、リポジトリ）。画面が、元のとおりには戻らなかったことを知らせるのに使う
export const taskRestoreClearedFields = ['story', 'assignee', 'category', 'repository'] as const;
export type TaskRestoreClearedField = (typeof taskRestoreClearedFields)[number];

export function taskRestoreConflictReasonOf(details: unknown): TaskRestoreConflictReason | undefined {
  return conflictReasonOf(details, taskRestoreConflictReasons);
}

// 削除したタスクを戻す（task-delete の取り消し）。deleted_at を空に戻し、変更の履歴（restore）を同時に書く。
// 親のストーリーと並びの位置は削除で変えていないので、そのまま元の場所に戻る（親が削除されていれば親なしで、親なしの並びの末尾に戻す）。スプリントには戻らない（削除で入っていた行を
// removed で閉じているため。戻したタスクはバックログにある。入れ直すのは sprint-task-add）。
// 削除の間に所属を外れた担当は担当なし（今日やるの印も外す）、削除された区分とリポジトリは空にして戻す。外した分は履歴の restore に残す。
// 戻せるのは、削除した人（今の削除を書いた人。期限は無い）と、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 無いタスク（別の組織・別のワークスペースを含む）は、権限より先に 404。断る理由は taskRestoreConflictReasons
export const taskRestore = defineOperation({
  name: 'task-restore',
  description:
    '削除したタスクを元の親と並びの位置に戻す。削除した人と、作った人とリーダー（管理者を含む）だけが戻せる。スプリントには戻らない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  output: z.object({ task_id: z.string(), cleared: z.array(z.enum(taskRestoreClearedFields)) }),
});
