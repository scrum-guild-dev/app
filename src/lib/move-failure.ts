import { moveConflictReasonOf } from '../shared/operations/task/task-move.ts';
import { t } from './vocabulary.svelte.ts';

// 失敗した移動の理由。バックログの画面と、ストーリーの引き出しの「親を移す」が同じ文を出す。
// 409 の conflict は、サーバーが details.reason に載せた理由で分ける。
// 親が完了していたときの文は、動かした行がタスク（親はストーリー）かストーリー（親はエピック）かで変える
export function moveFailureMessage(
  result: { status: number; error: { code: string; details?: unknown } | null },
  kind: 'task' | 'story' | 'epic',
): string {
  if (result.status === 404) return t('moveGone');
  if (result.status !== 409) return t('moveFailed');
  if (result.error?.code === 'workspace_closed') return t('workspaceClosedReadOnly', { workspace: t('workspace') });
  switch (moveConflictReasonOf(result.error?.details)) {
    case 'parent_completed':
      return kind === 'task'
        ? t('moveParentDone', { done: t('done'), story: t('story') })
        : t('moveEpicDone', { done: t('done'), epic: t('epic'), story: t('story') });
    case 'task_completed':
      return t('moveTaskDone', { task: t('task'), done: t('done') });
    case 'changed':
      return t('moveConflict');
    default:
      return t('moveFailed');
  }
}
