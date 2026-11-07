// 画面の見出し（h1.page-title。組織の外の紙の画面（運用など）では h1.gate-title）へフォーカスを移す。
// 戻す先の要素が無くなったとき（行が消えた、開いたボタンが作り直された）に使う。
// 見出しを focusable にしていない画面（メンバーなど）でも移せるよう、tabindex が無ければ -1 を付ける（Tab の順には入れない）
export function focusPageHeading(): void {
  const heading = document.querySelector<HTMLElement>('h1.page-title, h1.gate-title');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus();
}

// フォーカスがどこにも無い（押したボタンが消えて body に落ちたままの）状態か。待つ間に利用者が別の欄へ移っていたら偽で、
// 応答が返った時点でその人のフォーカスを奪わないための確かめ
export function focusIsFree(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

// 並べた ID の行（data-task-id を持つ題のリンクか、完了した行の題のボタン）のうち、フォーカスを受けられた最初の行へ。無ければ見出しへ
export function focusFirstTaskRow(ids: readonly (string | null)[]): void {
  for (const id of ids) {
    if (id === null) continue;
    const row = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    row?.focus();
    if (row !== null && document.activeElement === row) return;
  }
  focusPageHeading();
}
