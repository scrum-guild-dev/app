// キーボードのショートカットを一か所に登録する仕組み。root の +layout.svelte が keydown を1つだけ受けて、ここへ振り分ける。
// 各画面と部品は useShortcut で登録する。登録は部品が置かれている間だけで、外れると解除される（画面ごとの有効・無効を別に持たない）。
//
// 振り分けの決まり（部品ごとに書き直さない）:
// - 日本語の変換中のキー、ほかの処理が受けたキー（defaultPrevented）には働かない
// - 文字を打つ場所（入力欄など）では、inTyping を true にしたもの（Ctrl+K など修飾キー付き）だけが働く
// - ダイアログが開いている間は、inModal を true にしたものだけが働く（引き出しの `[` `]` は、引き出し自身がダイアログのため）
// - enabled が false を返す間は働かない
// - 同じキーを同時に2つ登録したら、開発中は例外にする。本番では後の登録を無視する（先の登録を壊さない）
import { untrack } from 'svelte';
import {
  isComposingKey,
  isTypingTarget,
  matchesKeys,
  normalizeKeys,
  parseKeys,
  type KeyEventLike,
  type ParsedKeys,
} from './shortcut-keys.ts';
import { modalState } from './toast.svelte.ts';

export interface Shortcut {
  // 画面や部品をまたいで一意の名前（衝突の知らせと、一覧の鍵に使う）
  id: string;
  // `Mod+K`、`[`、`c` の形（書き方は shortcut-keys.ts）
  keys: string;
  // 一覧に出す名前。辞書（t）を通した文字を返す
  label: () => string;
  run: (event: KeyboardEvent) => void;
  // false の間は働かない。キーが押された時点で読む
  enabled?: () => boolean;
  // 文字を打つ場所でも働くか（既定は働かない）
  inTyping?: boolean;
  // ダイアログが開いていても働くか（既定は働かない）
  inModal?: boolean;
  // 押しっぱなしの繰り返しでも働くか（既定は働かない）
  repeat?: boolean;
}

interface Entry {
  shortcut: Shortcut;
  parsed: ParsedKeys;
  normalized: string;
}

// 開いているダイアログ（native の dialog と role="dialog"）があるか。DOM が無い実行では閉じている扱い
function isDialogOpen(): boolean {
  if (modalState.openCount > 0) return true;
  return globalThis.document?.querySelector('dialog[open], [role="dialog"]:not([hidden])') != null;
}

export class ShortcutRegistry {
  // 一覧の画面などが読む写し。登録と解除のたびに作り直す
  items = $state.raw<Shortcut[]>([]);
  #entries: Entry[] = [];

  register(shortcut: Shortcut): () => void {
    const normalized = normalizeKeys(shortcut.keys);
    const clash = this.#entries.find((entry) => entry.normalized === normalized);
    if (clash) {
      const message = `ショートカットのキー ${shortcut.keys} が重なっています: ${clash.shortcut.id} と ${shortcut.id}`;
      if (import.meta.env.DEV) throw new Error(message);
      return () => {};
    }
    const entry: Entry = { shortcut, parsed: parseKeys(shortcut.keys), normalized };
    this.#entries = [...this.#entries, entry];
    this.items = this.#entries.map((item) => item.shortcut);
    return () => {
      this.#entries = this.#entries.filter((item) => item !== entry);
      this.items = this.#entries.map((item) => item.shortcut);
    };
  }

  // keydown を振り分ける。働いたら true（preventDefault 済み）
  handle = (event: KeyEventLike & { preventDefault(): void }): boolean => {
    if (event.defaultPrevented || isComposingKey(event)) return false;
    const entry = this.#entries.find(({ parsed }) => matchesKeys(parsed, event));
    if (!entry) return false;
    const { shortcut } = entry;
    if (!shortcut.inTyping && isTypingTarget(event.target)) return false;
    if (!shortcut.inModal && isDialogOpen()) return false;
    if (shortcut.enabled && !shortcut.enabled()) return false;
    event.preventDefault();
    // 押しっぱなしの繰り返しは、働かせずに奪うだけにする（Ctrl+K の長押しで、ブラウザの標準の Ctrl+K が動かないように）
    if (event.repeat && !shortcut.repeat) return true;
    shortcut.run(event as KeyboardEvent);
    return true;
  };
}

export const shortcuts = new ShortcutRegistry();

// 部品が置かれている間だけ登録する（部品の初期化の中で呼ぶ）。登録の中身は一度だけ読む
export function useShortcut(shortcut: () => Shortcut): void {
  $effect(() => {
    const definition = untrack(shortcut);
    return shortcuts.register(definition);
  });
}
