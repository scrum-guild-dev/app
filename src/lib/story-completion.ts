import { storyCompletionConflictReasonOf } from '../shared/operations/story/story-complete.ts';
import { t } from './vocabulary.svelte.ts';

// 断られたストーリーの完了と取り消しの理由。バックログの木の行と、ストーリーの引き出しが同じ文を出す。
// 409 の conflict は、サーバーが details.reason に載せた理由で分ける。reload が偽の失敗（通信、5xx）は、読み直さずに知らせる
export function completionFailureMessage(
  result: { status: number; error: { code: string; details?: unknown } | null },
  action: 'complete' | 'reopen',
): { message: string; reload: boolean } {
  const failed = action === 'complete' ? t('storyCompleteFailed', { done: t('done') }) : t('storyReopenFailed');
  if (result.status === 404) return { message: t('storyGone', { story: t('story') }), reload: true };
  if (result.status !== 409) return { message: failed, reload: false };
  if (result.error?.code === 'workspace_closed') {
    return { message: t('workspaceClosedReadOnly', { workspace: t('workspace') }), reload: true };
  }
  const words = { story: t('story'), task: t('task'), epic: t('epic'), done: t('done') };
  switch (storyCompletionConflictReasonOf(result.error?.details)) {
    case 'open_tasks':
      return { message: t('storyOpenTasks', words), reload: true };
    case 'completed':
      return { message: t('storyAlreadyDone', words), reload: true };
    case 'not_completed':
      return { message: t('storyNotDone', words), reload: true };
    case 'parent_completed':
      return {
        message: action === 'complete' ? t('storyCompleteParentDone', words) : t('storyReopenParentDone', words),
        reload: true,
      };
    case 'changed':
      return { message: t('storyCompletionChanged'), reload: true };
    default:
      return { message: failed, reload: true };
  }
}
