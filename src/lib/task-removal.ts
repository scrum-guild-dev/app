import { tick } from 'svelte';
import { taskDelete, taskRestore, taskRestoreConflictReasonOf } from '../shared/operations/task/index.ts';
import { callOperation } from './api.ts';
import type { AdjacentTasks } from './drawer.svelte.ts';
import { focusFirstTaskRow, focusIsFree, focusPageHeading } from './focus-heading.ts';
import { focusToastAction, pauseToast, resumeToast, showToast, type ToastAction } from './toast.svelte.ts';
import { visibleTaskIds } from './task-order.ts';
import { t } from './vocabulary.svelte.ts';

// タスクの削除と取り消し。引き出しの「この<タスク>を削除する」と、バックログの行とスプリントのカードの「⋯」が同じ文と同じフォーカスの扱いを使う。
// 消したら確認なしで「取り消す」付きのトーストを出し、押すと task-restore を送る。取り消しは引き出し（や行）が消えた後でも押せるよう、
// 消した時点の値（RestoreTarget）だけを使う

export type RestoreTarget = {
  slug: string;
  workspaceId: string;
  taskId: string;
  title: string;
  // 削除を送る前の前後の行（Esc で閉じたときのフォーカスの行き先）
  near: AdjacentTasks | null;
  onchanged: () => void;
  onstale: () => void;
  onrestored: ((taskId: string, focus: boolean) => Promise<void>) | undefined;
  onskipped: ((near: AdjacentTasks | null) => void) | undefined;
  // スプリントのボードから消したとき真。取り消しはスプリントには戻さない（task-restore）ので、戻した文でバックログにあることを伝える
  fromSprint?: boolean;
};

// 読み直しや、読み直しを含む後始末が失敗しても、捨てた Promise の未処理の reject にしない。失敗は文で知らせる。成功なら true
export async function settled(run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    showToast(t('taskListReloadFailed'), 'alert');
    return false;
  }
}

// 戻したことを知らせる文。外した参照があればそれを添え、ボードから消したときはバックログにあることを添える
function restoredMessage(target: RestoreTarget, cleared: readonly string[] = []): string {
  if (cleared.length > 0) {
    const params = { task: t('task'), fields: cleared.join('、'), sprint: t('sprint'), backlog: t('backlog') };
    return t(target.fromSprint === true ? 'taskRestoredClearedToBacklog' : 'taskRestoredCleared', params);
  }
  if (target.fromSprint === true) {
    return t('taskRestoredToBacklog', { task: t('task'), sprint: t('sprint'), backlog: t('backlog') });
  }
  return t('taskRestored', { task: t('task') });
}

// 消したことを知らせるトースト。「取り消す」を押すと task-restore を送り、木を読み直す
export function announceRemoved(target: RestoreTarget): number {
  return showToast(t('taskDeleted', { task: t('task'), title: target.title }), 'check', restoreActionOf(target));
}

// 並んだトーストを読み上げの名前で区別できるよう、ボタンの名前にタイトルを添える。Esc で閉じたときは近い行へフォーカスを移す
export function restoreActionOf(target: RestoreTarget): ToastAction {
  return {
    label: t('taskRestoreAction'),
    ariaLabel: t('taskRestoreActionLabel', { action: t('taskRestoreAction'), title: target.title }),
    run: (focused) => void restoreRemoved(target, focused),
    ...(target.onskipped === undefined ? {} : { onescape: () => target.onskipped?.(target.near) }),
  };
}

async function afterRestored(target: RestoreTarget, focused: boolean): Promise<void> {
  if (target.onrestored === undefined) target.onchanged();
  else await settled(() => target.onrestored?.(target.taskId, focused) ?? Promise.resolve());
}

// 通信の失敗と 5xx は一時的なので、「取り消す」付きのトーストで出し直す（403、404、409 は押し直しても変わらないので出し直さない）。
// 押したボタンにフォーカスがあったときは、出し直したトーストの「取り消す」へ置き直す
export async function restoreRemoved(target: RestoreTarget, focused = false): Promise<void> {
  const result = await callOperation(
    taskRestore,
    { workspace_id: target.workspaceId, task_id: target.taskId },
    { slug: target.slug },
  );
  if (result.ok) {
    const cleared = result.data.cleared.map((field) => t(field));
    showToast(restoredMessage(target, cleared), 'check');
    await afterRestored(target, focused);
  } else if (result.status === 401) {
    target.onstale();
  } else if (result.status === 403) {
    showToast(t('taskRestoreForbidden', { leader: t('leader') }), 'alert');
    keepFocus(focused);
  } else if (result.status === 404) {
    showToast(t('taskRestoreGone'), 'alert');
    target.onchanged();
    keepFocus(focused);
  } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
    showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
    target.onstale();
    keepFocus(focused);
  } else if (result.status === 409) {
    const reason = taskRestoreConflictReasonOf(result.error?.details);
    if (reason === 'not_deleted') {
      // 前の要求は書けたが応答だけが落ちて出し直した、または別の画面が先に戻した。戻っているので、成功と同じに扱う
      showToast(restoredMessage(target), 'check');
      await afterRestored(target, focused);
      return;
    }
    showToast(
      reason === 'parent_completed'
        ? t('taskRestoreParentCompleted', { story: t('story'), done: t('done') })
        : t('taskRestoreGone'),
      'alert',
    );
    target.onchanged();
    keepFocus(focused);
  } else if (result.status === 0 || result.status >= 500) {
    const id = showToast(t('taskRestoreRetry'), 'alert', restoreActionOf(target));
    // 待つ間に利用者が別へ移っていたら、フォーカスを奪わない
    if (focused && focusIsFree()) {
      pauseToast(id);
      void focusToastAction(id);
    }
  } else {
    showToast(t('taskRestoreFailed'), 'alert');
    keepFocus(focused);
  }
}

// 断られた（出し直さない）とき、押した「取り消す」が消えてフォーカスが body に落ちないよう、見出しへ置く
function keepFocus(focused: boolean): void {
  if (!focused) return;
  void tick().then(() => {
    if (focusIsFree()) focusPageHeading();
  });
}

// 画面に並んだ題のリンク（data-task-id）の順で、タスクの前後の行。端では null。画面に無ければ null
// スプリントのボードでは、同じ列（.board-col）の中の前後にする（列をまたいで隣の列の先頭へ行かない）
export function adjacentRowsOf(taskId: string): AdjacentTasks | null {
  const own = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
  const scope: ParentNode = own?.closest('.board-col') ?? document;
  // 畳んだ枝の中の見えない行と、重複した行は外す（引き出しの前後の順と同じ。見えない行へはフォーカスを移せない）
  const ids = visibleTaskIds(scope);
  const index = ids.indexOf(taskId);
  if (index < 0) return null;
  return { prev: ids[index - 1] ?? null, next: ids[index + 1] ?? null };
}

// 引き出しがこのタスクを開いているとき、消した後に引き出しを閉じる先の URL（`task` を外す。`story` と `epic_id` も外す。ハッシュは持たない）。開いていなければ null
export function urlWithoutOpenTask(href: string, taskId: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get('task') !== taskId) return null;
  for (const key of ['task', 'story', 'epic_id']) url.searchParams.delete(key);
  return url.pathname + url.search;
}

export type RemoveFromListArgs = {
  slug: string;
  workspaceId: string;
  taskId: string;
  title: string;
  // キーボードで選んだか（click の detail が 0）。真のときだけ、消した直後に「取り消す」へフォーカスを移す
  keyboard: boolean;
  // 消したタスクを引き出しが開いていたら、閉じる（引き出しは開いたとき一度だけ読むので、消えたタスクが出続けるため）
  closeDrawer?: (path: string) => Promise<void>;
  // 一覧（木、ボード）を読み直す。読み直しが済むまで待つ
  reload: () => Promise<void>;
  onstale: () => void;
  // 取り消した後（押したボタンにフォーカスがあったとき focus が真）と Esc で閉じた後のフォーカス
  onrestored: (taskId: string, focus: boolean) => Promise<void>;
  onskipped: (near: AdjacentTasks | null) => void;
  // スプリントのボードから消すとき真（取り消しの文でバックログにあることを伝える）
  fromSprint?: boolean;
};

// 送っている間のタスク。同じタスクを続けて選んでも、2回目は送らない（2回目は 404 の警告を出してしまうため）
const removing = new Set<string>();

// 行とカードの「⋯」から消す。確認は挟まない。通ったらトーストを出して一覧を読み直し、失敗は理由をトーストで知らせる。
// 消した行は読み直しで無くなるので、フォーカスは行の前後（無ければ見出し）へ移す。キーボードのときは続けて「取り消す」へ移す
export async function removeFromList(args: RemoveFromListArgs): Promise<void> {
  if (removing.has(args.taskId)) return;
  removing.add(args.taskId);
  try {
    await removeOnce(args);
  } finally {
    removing.delete(args.taskId);
  }
}

async function removeOnce(args: RemoveFromListArgs): Promise<void> {
  // 行が消える前に、近い行を控える
  const near = adjacentRowsOf(args.taskId);
  const result = await callOperation(
    taskDelete,
    { workspace_id: args.workspaceId, task_id: args.taskId },
    { slug: args.slug },
  );
  if (result.ok) {
    const toastId = announceRemoved({
      slug: args.slug,
      workspaceId: args.workspaceId,
      taskId: args.taskId,
      title: args.title,
      near,
      onchanged: () => void settled(args.reload),
      onstale: args.onstale,
      onrestored: args.onrestored,
      onskipped: args.onskipped,
      fromSprint: args.fromSprint === true,
    });
    // キーボードで消したときは、引き出しを閉じる間と木の読み直しを待つ間に10秒が尽きないよう、数えを止める（フォーカスが外れると数え直す）
    if (args.keyboard) pauseToast(toastId);
    // 引き出しを閉じるのに失敗しても（行を消した後の読み直しには関わらない）黙って続ける
    const drawerPath = urlWithoutOpenTask(location.href, args.taskId);
    if (drawerPath !== null) await args.closeDrawer?.(drawerPath)?.catch(() => {});
    const reloaded = await settled(async () => {
      await args.reload();
      await tick();
    });
    if (!reloaded) {
      if (args.keyboard) resumeToast(toastId);
      return;
    }
    if (!args.keyboard) return;
    // 待つ間に別の所へフォーカスを移した人からは奪わない（数えは戻す）
    if (!focusIsFree()) {
      resumeToast(toastId);
      return;
    }
    // 見出しを経由しない（長い一覧の途中で消したとき、見出しへのフォーカスでページの先頭へスクロールしてしまうため）。
    // 着かなかったときだけ、フォーカスが body に落ちないよう見出しへ置く
    if (!(await focusToastAction(toastId)) && focusIsFree()) focusPageHeading();
  } else if (result.status === 401) {
    args.onstale();
  } else if (result.status === 404) {
    showToast(t('taskGone', { task: t('task') }), 'alert');
    const reloaded = await settled(args.reload);
    // 行が消えて、キーボードで押した「⋯」のフォーカスが失われる。待つ間に別の所へ移した人からは奪わない（読み直しが失敗しても、フォーカスは body に落ちる）
    if (reloaded) await tick();
    if (args.keyboard && focusIsFree()) focusPageHeading();
  } else if (result.status === 403) {
    showToast(t('taskDeleteForbidden', { leader: t('leader') }), 'alert');
    await settled(args.reload);
  } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
    showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
    args.onstale();
  } else if (result.status === 409) {
    // 取り込んだタスクは削除できない
    showToast(t('taskImportedNoDelete', { task: t('task'), archive: t('archive') }), 'alert');
    await settled(args.reload);
  } else {
    showToast(t('taskDeleteFailed'), 'alert');
  }
}

// 「取り消す」で戻した後のフォーカス。木かボードを読み直したあと、押したボタンにフォーカスがあり、待つ間に利用者が別へ移っていなければ、
// 戻したタスクの題のリンクへ（無ければ見出しへ）移す
export async function focusRestored(restoredId: string, focus: boolean): Promise<void> {
  await tick();
  if (focus && focusIsFree()) focusFirstTaskRow([restoredId]);
}

// フォーカスがある「取り消す」を Esc で閉じた後のフォーカス。消した行の次の行、無ければ前の行、無ければ見出しへ移す
export function focusSkipped(near: AdjacentTasks | null): void {
  void tick().then(() => focusFirstTaskRow([near?.next ?? null, near?.prev ?? null]));
}
