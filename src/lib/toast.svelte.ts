import { tick } from 'svelte';
import type { IconName } from './icons.ts';

// action を付けると、文の後ろに押せるボタン（.toast-action）を出す。押すと run を呼んで、そのトーストを消す。
// run には、押したときそのボタンにフォーカスがあったか（キーボードか、フォーカスを受ける押し方）を渡す。あれば、消えたボタンの代わりに
// フォーカスを置き直す（フォーカスが無いときに奪わないため）。
// ariaLabel は、並んだ複数のトーストを読み上げの名前で区別したいときに、ボタンの名前を替える（見える文字は label のまま）。
// onescape を渡すと、フォーカスがあるときの Esc でそのトーストを（onclose を呼ばずに）閉じ、onescape を呼ぶ。渡さなければ Esc は何もしない
export type ToastAction = {
  label: string;
  ariaLabel?: string;
  run: (focused: boolean) => void;
  onescape?: () => void;
};

// onclose は、操作を押さずに消えるとき（時間切れ、あふれて押し出された、dismissToast）に1回だけ呼ぶ。
// 操作を押したときは呼ばず、run だけを呼ぶ。消えるのを待ってから送る操作（コメントの削除）のためにある
export type Toast = { id: number; message: string; icon?: IconName; action?: ToastAction; onclose?: () => void };

// 数秒で消える短い知らせ。kit.js の toast と同じ 4 秒。操作を付けたものは、押す間があるよう 10 秒で、
// ポインターが乗っている間とフォーカスがある間は数えるのを止め、外れてから数え直す（pauseToast、resumeToast）。
// 操作は、同じことを画面のほかの場所でもできるものだけにする（消えても、できることを失わないため）。
// 例外は、取り消せるのが出ている間だけの操作。消えるのを待ってから送る取り消し（コメントの削除。消えること自体が「送る」合図）と、
// 送った後に戻す取り消し（タスクの削除。「取り消す」で task-restore を送る）
const toastLifetimeMs = 4000;
const actionToastLifetimeMs = 10000;
// 同時に出す数。あふれたら古いものから消す
const maxToasts = 3;

export const toasts: Toast[] = $state([]);

// モーダルのダイアログが開いている数。開いている間、外側は inert で読み上げも届かないので、
// トーストはダイアログの中の領域に出し、外側の領域は隠す（ToastRegion.svelte、Dialog.svelte）
export const modalState = $state({ openCount: 0 });

let nextId = 0;
// トーストごとの、消すまでのタイマー。描き直しには使わないので、リアクティブにしない
const timers: Record<number, ReturnType<typeof setTimeout>> = {};

function stopTimer(id: number): void {
  clearTimeout(timers[id]);
  delete timers[id];
}

// silent を真にすると onclose を呼ばない（呼ぶ側が自分で片付けるとき）
export function dismissToast(id: number, silent = false): void {
  stopTimer(id);
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index === -1) return;
  const [toast] = toasts.splice(index, 1);
  if (!silent) toast?.onclose?.();
}

// 操作のボタンを押したとき。onclose は呼ばずにトーストを消し、run を呼ぶ
export function runToastAction(id: number, focused = false): void {
  const action = toasts.find((toast) => toast.id === id)?.action;
  dismissToast(id, true);
  action?.run(focused);
}

// フォーカスがあるトーストで Esc を押したとき。onescape を持つトーストだけを、onclose を呼ばずに閉じる
export function escapeToast(id: number): boolean {
  const action = toasts.find((toast) => toast.id === id)?.action;
  if (action?.onescape === undefined) return false;
  dismissToast(id, true);
  action.onescape();
  return true;
}

// 操作の付いたトーストのボタンへフォーカスを移す。フォーカスが入ると消すまでの時間が止まる（pauseToast）ので、
// キーボードで消した人が10秒で取り逃さずに「取り消す」へ届く。描かれるのと、モーダルが閉じて領域の hidden が外れるのを待つ
export async function focusToastAction(id: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await tick();
    const button = document.querySelector<HTMLElement>(`.toasts:not([hidden]) [data-toast-id="${id}"] .toast-action`);
    if (button) {
      button.focus();
      if (document.activeElement === button) return true;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return false;
}

function schedule(id: number, lifetime: number): void {
  stopTimer(id);
  timers[id] = setTimeout(() => dismissToast(id), lifetime);
}

// 操作の付いたトーストの、消すまでの時間を止める（ポインターが乗った、フォーカスが入った）
export function pauseToast(id: number): void {
  stopTimer(id);
}

// 止めていた時間を、初めから数え直す（ポインターとフォーカスが外れた）
export function resumeToast(id: number): void {
  if (toasts.some((toast) => toast.id === id)) schedule(id, actionToastLifetimeMs);
}

// message は文字列として出す（HTML として埋め込まない）。呼ぶ側は辞書を通した文言を渡す
export function showToast(message: string, icon?: IconName, action?: ToastAction, onclose?: () => void): number {
  const id = nextId++;
  toasts.push({
    id,
    message,
    icon,
    ...(action === undefined ? {} : { action }),
    ...(onclose === undefined ? {} : { onclose }),
  });
  if (toasts.length > maxToasts) {
    for (const old of toasts.slice(0, toasts.length - maxToasts)) dismissToast(old.id);
  }
  schedule(id, action === undefined ? toastLifetimeMs : actionToastLifetimeMs);
  return id;
}
