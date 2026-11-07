// ショートカットの一覧（? で開くダイアログ）に出す行を、登録から選んで分ける純粋な関数。ShortcutHelp.svelte が使う。
import type { Shortcut } from './shortcuts.svelte.ts';

export interface ShortcutHelpGroups {
  // 今の画面だけで効くキー（空の行へ移る `c` など）
  screen: Shortcut[];
  // どの画面でも効くキー（検索、画面を移るキー、この一覧を開く `?`）
  global: Shortcut[];
}

// 一覧に順を付けない登録の位置。検索（1）、画面を移るキー（2）より後ろ、一覧を開く `?`（9）より前に置き、global の付け忘れ・順の付け忘れが先頭に出ないようにする
export const DEFAULT_HELP_ORDER = 5;

// enabled が例外を投げる登録があっても、一覧は開けるようにする（その登録だけ出さない）。
// 見せ方だけを守る意図で、例外は握りつぶす（キーの振り分け ShortcutRegistry.handle は enabled を守らない。部品が外れる途中の参照などで一時的に投げうる）
function isListed(shortcut: Shortcut): boolean {
  try {
    return shortcut.enabled?.() !== false;
  } catch {
    return false;
  }
}

// 組の中は helpOrder の小さい順（既定は DEFAULT_HELP_ORDER）で、同じ値は登録された順に並べる（部品が置かれる順に左右されないよう、順は登録に持たせる）。
// enabled が false のもの（今は働かない `c` や、今いる画面へ移る `g b`）は出さない。
// 文字を打つ場所とダイアログの判定（isAvailable）は見ない（一覧を開く時点では、後者が一覧自身になるため）
export function shortcutHelpGroups(items: readonly Shortcut[]): ShortcutHelpGroups {
  const groups: ShortcutHelpGroups = { screen: [], global: [] };
  const seen = new Set<string>();
  for (const shortcut of items) {
    if (seen.has(shortcut.id) || !isListed(shortcut)) continue;
    seen.add(shortcut.id);
    (shortcut.global ? groups.global : groups.screen).push(shortcut);
  }
  const byOrder = (a: Shortcut, b: Shortcut) =>
    (a.helpOrder ?? DEFAULT_HELP_ORDER) - (b.helpOrder ?? DEFAULT_HELP_ORDER);
  groups.screen.sort(byOrder);
  groups.global.sort(byOrder);
  return groups;
}
