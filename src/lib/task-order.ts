import { provideStoryOrder, provideTaskOrder, releaseStoryOrder, releaseTaskOrder } from './drawer.svelte.ts';

// 画面に今見えている行の ID を、画面の上から下の順に返す。属性は data-task-id（タスク）か data-story-id（ストーリー）。
// 畳んだ枝（TreeStory、TreeEpic の hidden）の中の行は、DOM には残るが見えないので外す。
// 畳み方の状態は各部品の中にあるので、画面のデータから順を組まず、描かれた結果を読む。同じ行が2つ描かれていれば、先の1つだけを数える
function visibleIds(root: ParentNode, attribute: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const element of root.querySelectorAll(`[${attribute}]`)) {
    const id = element.getAttribute(attribute);
    if (id === null || id === '' || seen.has(id) || element.closest('[hidden]') !== null) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// タスクの行の ID。引き出しの前後の移動の順になる。
// 行は data-task-id を持つリンクかボタン（TaskEntry、CompletedTasks、SprintCard、計画の行）。ストーリーとエピックの行は持たないので入らない
export function visibleTaskIds(root: ParentNode): string[] {
  return visibleIds(root, 'data-task-id');
}

// ストーリーの行の ID。ストーリーの引き出しの前後の移動の順になる。行は data-story-id を持つ題のリンク（TreeStory）
export function visibleStoryIds(root: ParentNode): string[] {
  return visibleIds(root, 'data-story-id');
}

// 前後のボタンで移ってきて置き直した引き出しが、最初にフォーカスを置くボタンの向き。
// 押した向きのボタンが押せるならその向き、押せない（端）か向きが無い（普通に開いた、キーで移った）なら null（閉じるボタン）。
// 読み込み中も押した向きのボタンにフォーカスがあれば、Enter の連打が閉じるボタンに届かない
export function stepFocusTarget(
  initialFocus: -1 | 1 | null,
  adjacent: { hasPrev: boolean; hasNext: boolean } | undefined,
): -1 | 1 | null {
  if (initialFocus === null || adjacent === undefined) return null;
  return (initialFocus < 0 ? adjacent.hasPrev : adjacent.hasNext) ? initialFocus : null;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

// 行の入れ物に付ける（`{@attach trackTaskOrder}`）。付いている間、見えている行の順を引き出しへ渡し、外れたら空へ戻す。
// 行の出入り、並べ替え、畳む／開くを MutationObserver で追う（同じ順のときは渡し直さない）。
// 引き出しを開いていなくても木は変わり続けるので、変化は requestAnimationFrame でまとめ、1フレームに1回だけ全行を走査する
function trackOrder(
  root: HTMLElement,
  attribute: string,
  provide: (owner: symbol, ids: readonly string[]) => void,
  release: (owner: symbol) => void,
): () => void {
  const owner = Symbol(attribute);
  let current: readonly string[] = visibleIds(root, attribute);
  provide(owner, current);
  let frame: number | null = null;
  const observer = new MutationObserver(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const next = visibleIds(root, attribute);
      if (sameIds(next, current)) return;
      current = next;
      provide(owner, next);
    });
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', attribute],
  });
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    release(owner);
  };
}

export function trackTaskOrder(root: HTMLElement): () => void {
  return trackOrder(root, 'data-task-id', provideTaskOrder, releaseTaskOrder);
}

// ストーリーの行の順を、ストーリーの引き出しへ渡す（`{@attach trackStoryOrder}`。仕組みはタスクの順と同じ）
export function trackStoryOrder(root: HTMLElement): () => void {
  return trackOrder(root, 'data-story-id', provideStoryOrder, releaseStoryOrder);
}
