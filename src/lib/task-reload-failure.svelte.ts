import { tick } from 'svelte';
import { showToast } from './toast.svelte.ts';
import { t } from './vocabulary.svelte.ts';

// 行とカードの「⋯」から消した（戻した）後の読み直しの失敗の印（#979）。トーストは消えるので、大事なこと（消した、戻したことは済んでいる）を
// 画面に残す。木とボードの load は、通信と 5xx の失敗で一覧を null にするので、画面は読み込みの失敗（LoadFailed）に替わる。
// その画面の見出しの下に、何が済んだかを添える（data-task-reload-note）。
// 印は画面をまたいで持つ（スプリントで消し、バックログへ移ってからトーストの「取り消す」を押すと、読み直すのはバックログの画面のため）。
// どの画面でも一覧が読めたら下ろす。別のワークスペースの読み込みの失敗には出さない。
// 印を出す画面が無い（読み直し自体が投げて、一覧が前のまま残った）ときは、トーストで知らせて印を下ろす

// 何が済んだか。deleted は消した後、restored は戻した後、stale は断られた後の読み直し（何も変えていない）
export type ReloadFailure = 'deleted' | 'restored' | 'stale';

const current = $state<{ failure: ReloadFailure | null; workspaceId: string | null }>({
  failure: null,
  workspaceId: null,
});

// このワークスペースの印の文。印が無ければ null
export function reloadFailureNote(workspaceId: string): string | null {
  if (current.failure === null || current.workspaceId !== workspaceId) return null;
  return reloadFailureMessage(current.failure);
}

export function reloadFailureMessage(failure: ReloadFailure): string {
  if (failure === 'deleted') return t('taskDeletedReloadFailed', { task: t('task') });
  if (failure === 'restored') return t('taskRestoredReloadFailed', { task: t('task') });
  return t('taskListStaleReloadFailed');
}

// 読み直しが失敗した。先に出ている「削除しましたが」「戻しましたが」を、断られた後の読み直し（stale）で上書きしない
export function markReloadFailed(failure: ReloadFailure, workspaceId: string): void {
  const keep = failure === 'stale' && current.failure !== null && current.workspaceId === workspaceId;
  if (!keep) {
    current.failure = failure;
    current.workspaceId = workspaceId;
  }
  void tick().then(() => {
    if (current.failure === null || document.querySelector('[data-task-reload-note]') !== null) return;
    clearReloadFailure();
    showToast(t('taskListReloadFailed'), 'alert');
  });
}

// 一覧が読めた（どの経路でも）。印を下ろす
export function clearReloadFailure(): void {
  current.failure = null;
  current.workspaceId = null;
}

// 読み直した後、今開いている画面の一覧（バックログの木、スプリントのボード）が読めなかったら投げる。
// load は通信と 5xx の失敗で一覧を null にし、invalidate 自体は失敗しないので、ここで読み直しの失敗に替える。
// 見るのは今の画面（呼び出し側が渡す $app/state の page.data）で、読み直しを頼んだ画面ではない（トーストの「取り消す」は画面をまたいで押せる）
export async function throwIfListFailed(current: () => Record<string, unknown>): Promise<void> {
  await tick();
  const data = current();
  if (('tree' in data && data.tree === null) || ('board' in data && data.board === null)) {
    throw new Error('list');
  }
}
