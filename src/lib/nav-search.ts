import { emptyFilter, filterFromParams, filterSearch } from './backlog-filter.ts';

// 上の帯の検索の候補。画面の名前（左のメニューの項目）と、今のワークスペースのバックログの検索（?q=）へ送る行。
// 画面の名前は呼び出し側が辞書から引いて渡す。ここは並べ方と絞り方だけを持つ

export type NavSearchScreen = { label: string; href: string };
export type NavSearchOption = { id: string; label: string; href: string; kind: 'screen' | 'backlog' };

// 全角と半角、大文字と小文字の違いを見ずに比べる
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

// 入力の語をすべて含む画面だけを残す。入力が空なら全部（開いたら使える画面を見渡せる）
export function matchScreens(query: string, screens: readonly NavSearchScreen[]): NavSearchScreen[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return screens.filter((screen) => {
    const label = fold(screen.label);
    return words.every((word) => label.includes(word));
  });
}

// バックログへ送る行き先。backlogHref は今のワークスペースのバックログの経路（解決済み）。
// 絞り込みの検索は backlog-filter の整え方（語の数と長さの上限）を通すので、手で打った長い文でも API に断られない
export function backlogSearchHref(backlogHref: string, query: string): string | null {
  const q = filterFromParams(new URLSearchParams({ q: query })).q;
  if (q === '') return null;
  return `${backlogHref}${filterSearch('', { ...emptyFilter, q })}`;
}

export function searchOptions(
  query: string,
  screens: readonly NavSearchScreen[],
  backlog: { href: string; label: (query: string) => string } | null,
): NavSearchOption[] {
  const options: NavSearchOption[] = matchScreens(query, screens).map((screen, index) => ({
    id: `screen-${index}`,
    label: screen.label,
    href: screen.href,
    kind: 'screen',
  }));
  if (backlog) {
    const href = backlogSearchHref(backlog.href, query);
    if (href) options.push({ id: 'backlog', label: backlog.label(query.trim()), href, kind: 'backlog' });
  }
  return options;
}
