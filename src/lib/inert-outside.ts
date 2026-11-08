// 要素の外側を操作できなくする（キーボードのフォーカスも、読み上げも届かなくする）。
// 引き出しは <dialog> の showModal() を使わないので、
// モーダルの形（横と真ん中）のときだけ、要素から body まで、各階層の兄弟に inert を付ける。返す関数で元に戻す。
// keep が真の兄弟は残す（幕、トースト、別のダイアログ）。すでに inert の要素は触らない。
// 開いている間に差し込まれた兄弟（背後の画面が読み込みの失敗に替わる、戻って一覧を作り直すなど）にも付ける。
// 付けないと、作り直した背後の行の「⋯」へキーボードで届き、引き出しを開いたまま同じタスクを消せてしまう（#977）
export function inertOutside(target: Element, keep: (sibling: Element) => boolean): () => void {
  const changed: Element[] = [];
  const parents: Element[] = [];
  const mark = (sibling: Element, node: Element): void => {
    if (sibling === node || sibling.hasAttribute('inert') || keep(sibling)) return;
    sibling.setAttribute('inert', '');
    changed.push(sibling);
  };
  // 各階層の親と、その階層で残す自分（target か、target を含む祖先）
  const levels = new Map<Element, Element>();
  for (let node: Element | null = target; node !== null && node !== document.body; node = node.parentElement) {
    const parent = node.parentElement;
    if (parent === null) continue;
    levels.set(parent, node);
    parents.push(parent);
    for (const sibling of parent.children) mark(sibling, node);
  }
  const observer =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => {
          for (const record of records) {
            const node = levels.get(record.target as Element);
            if (node === undefined) continue;
            for (const added of record.addedNodes) {
              if (added instanceof Element) mark(added, node);
            }
          }
        });
  for (const parent of parents) observer?.observe(parent, { childList: true });
  return () => {
    observer?.disconnect();
    for (const element of changed) element.removeAttribute('inert');
  };
}
