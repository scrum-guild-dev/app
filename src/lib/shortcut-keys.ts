// ショートカットのキーの書き方と、押されたキーが当てはまるかの判定。登録の仕組み（shortcuts.svelte.ts）が使う純粋な関数。
//
// キーは文字列で書く。
// - `Mod+K` … Ctrl か ⌘（Meta）と K。Alt と Shift は付けない。英字は大文字小文字を区別しない
// - `[`、`c`、`?` … 修飾キー（Ctrl、⌘、Alt）なしの1文字。押された `key` と完全に同じ文字で当てる（`c` と `C` は別）。
//   Shift は見ない。`?` のように Shift で出る文字は、Shift を押して出た `key` の文字そのもので当てる
// - `g b` … 続けて押す2つの単キー（空白で区切る）。1つ目を押して約1秒のうちに2つ目を押すと当たる。修飾キーは付けない

export type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'keyCode' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'
> & { target: EventTarget | null };

// 今見ている一覧の空の行へフォーカスを移すキー。登録（useShortcut）と DraftRow の aria-keyshortcuts が同じ値を使う
export const NEW_TASK_KEY = 'c';

export interface ParsedKeys {
  // Ctrl か ⌘ を要るか
  mod: boolean;
  // 当てる文字。mod 付きは小文字にそろえる
  key: string;
  // 続けて押すキー（`g b`）の1つ目の文字。単独のキーでは無い
  prefix?: string;
}

export function parseKeys(keys: string): ParsedKeys {
  if (keys.includes(' ')) {
    const parts = keys.split(' ');
    if (parts.length !== 2 || parts.some((part) => part.length !== 1 || part === ' '))
      throw new Error(`ショートカットのキーが読めません: ${keys}`);
    return { mod: false, key: parts[1], prefix: parts[0] };
  }
  if (keys.startsWith('Mod+')) {
    const key = keys.slice(4);
    if (key.length !== 1) throw new Error(`ショートカットのキーが読めません: ${keys}`);
    return { mod: true, key: key.toLowerCase() };
  }
  if (keys.length !== 1) throw new Error(`ショートカットのキーが読めません: ${keys}`);
  return { mod: false, key: keys };
}

// 同じキーを同じ書き方にそろえる（衝突の検出のため）
export function normalizeKeys(keys: string): string {
  const { mod, key, prefix } = parseKeys(keys);
  if (prefix !== undefined) return `${prefix} ${key}`;
  return mod ? `Mod+${key}` : key;
}

// 押されたキーが、このキーに当たるか。日本語の変換中の判定とは別にする（変換中は呼び出し側が先に除く）
export function matchesKeys(
  keys: ParsedKeys,
  event: Pick<KeyEventLike, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (keys.mod) {
    return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === keys.key;
  }
  return !event.ctrlKey && !event.metaKey && !event.altKey && event.key === keys.key;
}

// 読み上げのための aria-keyshortcuts の値。Mod は Control と Meta の両方を並べる
export function ariaKeyshortcuts(keys: string): string {
  const { mod, key, prefix } = parseKeys(keys);
  // 続けて押すキーには使えない（空白で並べると「g または b」の代わりのキーに読まれ、順番を表す書き方は WAI-ARIA に無い）。
  // 読み上げには、リンクの説明の文（aria-describedby。辞書の shortcutGoHint）で伝える
  if (prefix !== undefined) throw new Error(`続けて押すキーは aria-keyshortcuts にできません: ${keys}`);
  const upper = key.toUpperCase();
  return mod ? `Control+${upper} Meta+${upper}` : key;
}

// 日本語の変換中のキー。keyCode 229 は、isComposing が偽になる Safari の変換確定の直後も含む
export function isComposingKey(event: Pick<KeyEventLike, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}

// 文字や数字を入れる input の型。ブラウザは type 属性が無いか不明な値の input を 'text' として返す（空文字は属性が空のときの保険）。
// radio、checkbox、button、range など文字を打たない型は含めない（ポイントの radio にフォーカスがあっても前後へ移れる）
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  '',
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

// キー入力の先が、文字を打つ場所か（文字を入れる型の input、textarea、select、contenteditable）。単キーのショートカットで打つ人の邪魔をしない
export function isTypingTarget(target: unknown): boolean {
  const element = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (element === null || element === undefined) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && TEXT_INPUT_TYPES.has((element.type ?? '').toLowerCase());
}
