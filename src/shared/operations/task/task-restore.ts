import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// タスクの削除を取り消すのを 409 の conflict で断った理由（details.reason）。
// not_deleted は削除していないタスクを戻そうとした（2つの画面から同時に戻した後の方を含む）、
// parent_deleted は親のストーリーが削除されている（親なしで戻すと、消した覚えのない場所に現れるので断る。先にストーリーを戻す）、
// parent_completed は完了していないタスクを、完了したストーリーの下へ戻そうとした（ストーリーの完了を取り消してから戻す）
export const taskRestoreConflictReasons = ['not_deleted', 'parent_deleted', 'parent_completed'] as const;
export type TaskRestoreConflictReason = (typeof taskRestoreConflictReasons)[number];

export function taskRestoreConflictReasonOf(details: unknown): TaskRestoreConflictReason | undefined {
  return conflictReasonOf(details, taskRestoreConflictReasons);
}

// 削除したタスクを戻す（task-delete の取り消し）。deleted_at を空に戻し、変更の履歴（restore）を同時に書く。
// 親のストーリーと並びの位置は削除で変えていないので、そのまま元の場所に戻る。スプリントには戻らない（削除で入っていた行を
// removed で閉じているため。戻したタスクはバックログにある。入れ直すのは sprint-task-add）。
// 戻せるのは、削除した人と、作った人とリーダー（管理者を含む）。それ以外は 403 の forbidden。
// 無いタスク（別の組織・別のワークスペースを含む）は、権限より先に 404。断る理由は taskRestoreConflictReasons
export const taskRestore = defineOperation({
  name: 'task-restore',
  description:
    '削除したタスクを元の親と並びの位置に戻す。削除した人と、作った人とリーダー（管理者を含む）だけが戻せる。スプリントには戻らない',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema }),
  output: z.object({ task_id: z.string() }),
});
