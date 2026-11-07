// ショートカットの一覧（? で開くダイアログ）に出す行を、登録から選んで分ける純粋な関数。ShortcutHelp.svelte が使う。
import type { Shortcut } from './shortcuts.svelte.ts';

export interface ShortcutHelpGroups {
  // 今の画面だけで効くキー（空の行へ移る `c`、引き出しの `[` `]` など）
  screen: Shortcut[];
  // どの画面でも効くキー（検索、画面を移るキー、この一覧を開く `?`）
  global: Shortcut[];
}

// 登録された順に並べる。enabled が false のもの（今は働かない `c` や、今いる画面へ移る `g b`）は出さない。
// 文字を打つ場所とダイアログの判定（isAvailable）は見ない（一覧を開く時点では、後者が一覧自身になるため）
export function shortcutHelpGroups(items: readonly Shortcut[]): ShortcutHelpGroups {
  const groups: ShortcutHelpGroups = { screen: [], global: [] };
  const seen = new Set<string>();
  for (const shortcut of items) {
    if (seen.has(shortcut.id) || shortcut.enabled?.() === false) continue;
    seen.add(shortcut.id);
    (shortcut.global ? groups.global : groups.screen).push(shortcut);
  }
  return groups;
}
