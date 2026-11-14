// Playwright の初期スクリプトとして渡す。ページ側で動くので、この関数の外の値を参照しない。
export function installDevOpenTitle({ origin, worktree }: { origin: string; worktree: string }): void {
  // 同じ context で外のサイトを開いても、手元の確かめと表示しない。埋め込みの題も変えない。
  if (window.top !== window.self || location.origin !== origin) return;

  const label = `手元の確かめ｜${worktree}`;
  const prefix = `${label}｜`;
  const update = () => {
    const title = document.title;
    if (title !== label && !title.startsWith(prefix)) document.title = title ? `${prefix}${title}` : label;
  };
  // 初期スクリプトは head が出来る前にも動く。document を監視し、title の追加・置換と SPA の更新を拾う。
  new MutationObserver(update).observe(document, { childList: true, subtree: true, characterData: true });
  update();
}
