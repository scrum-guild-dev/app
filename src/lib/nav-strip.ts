// 760px 以下のメニューの帯（横に送る .nav）の送り位置と、端に続きがあるかの判定。見本は design/kit.js の syncNavStrip で同じ計算をする。
// 座標はどれも画面の座標（getBoundingClientRect）で渡す

// 手前の項目を欠けて見せる幅。左にも項目があると分かるようにする
export const NAV_STRIP_PEEK = 32;

export type NavStripView = { scrollLeft: number; left: number; width: number };
export type NavStripBox = { left: number; right: number };

// 今のページの項目が欠けずに見えていれば null（送らない）。欠けていれば、項目の左に手前の項目を少し残す scrollLeft を返す。
// 項目がワークスペースの節にあり、節の先頭（ワークスペースの札）から項目までが帯に収まるなら、札も見える位置まで送る
// （書体を読み終えて幅が変わり、札だけが隠れたときも送り直す）
export function navStripScrollLeft(
  view: NavStripView,
  item: NavStripBox,
  group: NavStripBox | null,
  peek: number = NAV_STRIP_PEEK,
): number | null {
  const fitsWithGroup = group !== null && group.left <= item.left && item.right - group.left <= view.width - peek;
  const start = fitsWithGroup ? group.left : item.left;
  // 札（収まるとき）から項目までが欠けずに見えていれば送らない
  if (start >= view.left && item.right <= view.left + view.width) return null;
  return Math.max(0, view.scrollLeft + start - view.left - peek);
}

// 左と右に送れる続きがあるか。小数の誤差で端に届いても続きありとしないよう、1px の遊びを持つ
export function navStripEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { start: boolean; end: boolean } {
  return { start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 };
}
