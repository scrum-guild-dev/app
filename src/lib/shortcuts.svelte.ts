// キーボードのショートカットを一か所に登録する仕組み。root の +layout.svelte が keydown を1つだけ受けて、ここへ振り分ける。
// 各画面と部品は useShortcut で登録する。登録は部品が置かれている間だけで、外れると解除される（画面ごとの有効・無効を別に持たない）。
//
// 振り分けの決まり（部品ごとに書き直さない）:
// - 日本語の変換中のキー、ほかの処理が受けたキー（defaultPrevented）には働かない
// - 文字を打つ場所（入力欄など）では、inTyping を true にしたもの（Ctrl+K など修飾キー付き）だけが働く
// - ダイアログが開いている間は、inModal を true にしたものだけが働く（引き出しの `[` `]` は、引き出し自身がダイアログのため）
// - enabled が false を返す間は働かない
// - 続けて押すキー（`g b`）は、1つ目で待ちに入り、約1秒のうちの2つ目で働く。待ち中に別のキーを押すと待ちは切れる
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
  // どの画面でも働くか（検索、画面を移るキー、一覧を開く `?`）。一覧（ShortcutHelp）で「今の画面」の下に分けて出す。既定は今の画面のキー
  global?: boolean;
  // ヒント（⌘ を押し続けたときに角へ出すキー）を付ける要素。返さない（未定義、null）間は出さない。入力欄は包む枠を返す
  hintAnchor?: () => HTMLElement | null | undefined;
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

// 続けて押すキーの、1つ目から2つ目までの待ち時間（ミリ秒）
export const CHORD_TIMEOUT_MS = 1000;

export class ShortcutRegistry {
  // 一覧の画面などが読む写し。登録と解除のたびに作り直す
  items = $state.raw<Shortcut[]>([]);
  #entries: Entry[] = [];
  // 1つ目を押して待っている、続けて押すキー
  #pending: { prefix: string; at: number } | null = null;

  register(shortcut: Shortcut): () => void {
    const normalized = normalizeKeys(shortcut.keys);
    const parsed = parseKeys(shortcut.keys);
    // 同じキーのほか、単独のキーと続けて押すキーの1つ目が同じ（`g` と `g b`）ものも重なり
    const clash = this.#entries.find(
      (entry) =>
        entry.normalized === normalized ||
        (parsed.prefix === undefined && !parsed.mod && entry.parsed.prefix === parsed.key) ||
        (parsed.prefix !== undefined &&
          !entry.parsed.mod &&
          entry.parsed.prefix === undefined &&
          entry.parsed.key === parsed.prefix),
    );
    if (clash) {
      const message = `ショートカットのキー ${shortcut.keys} が重なっています: ${clash.shortcut.id} と ${shortcut.id}`;
      if (import.meta.env.DEV) throw new Error(message);
      return () => {};
    }
    const entry: Entry = { shortcut, parsed, normalized };
    this.#entries = [...this.#entries, entry];
    this.items = this.#entries.map((item) => item.shortcut);
    return () => {
      this.#entries = this.#entries.filter((item) => item !== entry);
      this.items = this.#entries.map((item) => item.shortcut);
    };
  }

  // 今、そのキーを押せば働く状況か（文字を打つ場所、ダイアログ、enabled。振り分けとヒントが同じ判定を使う）
  isAvailable(shortcut: Shortcut, target: EventTarget | null): boolean {
    if (!shortcut.inTyping && isTypingTarget(target)) return false;
    if (!shortcut.inModal && isDialogOpen()) return false;
    if (shortcut.enabled && !shortcut.enabled()) return false;
    return true;
  }

  // keydown を振り分ける。働いたら true（preventDefault 済み）
  handle = (event: KeyEventLike & { preventDefault(): void }): boolean => {
    // 待ちは次のキーで必ず片づける。修飾キーだけの押下（Shift など）は待ちを切らない
    const pending = this.#pending;
    if (['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock'].includes(event.key)) return false;
    this.#pending = null;
    if (event.defaultPrevented || isComposingKey(event)) return false;
    const waiting = pending !== null && Date.now() - pending.at <= CHORD_TIMEOUT_MS ? pending.prefix : null;
    const entry = this.#entries.find(({ parsed }) =>
      waiting === null
        ? parsed.prefix === undefined && matchesKeys(parsed, event)
        : parsed.prefix === waiting && matchesKeys(parsed, event),
    );
    if (!entry) {
      // 続けて押すキーの1つ目なら待ちに入る（働く条件を満たす続きが1つでもあるときだけ）
      if (waiting === null && !event.repeat) {
        const starts = this.#entries.some(
          ({ parsed, shortcut }) =>
            parsed.prefix !== undefined &&
            matchesKeys({ mod: false, key: parsed.prefix }, event) &&
            this.isAvailable(shortcut, event.target),
        );
        if (starts) {
          event.preventDefault();
          this.#pending = { prefix: event.key, at: Date.now() };
          return true;
        }
      }
      return false;
    }
    const { shortcut } = entry;
    if (!this.isAvailable(shortcut, event.target)) return false;
    // 押しっぱなしの繰り返しは働かせない。Ctrl/⌘ 付きのキーだけは奪う（Ctrl+K の長押しで、ブラウザの標準の Ctrl+K が動かないように）
    if (event.repeat && !shortcut.repeat) {
      if (!entry.parsed.mod) return false;
      event.preventDefault();
      return true;
    }
    event.preventDefault();
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
