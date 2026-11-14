// テーマの値と、data-theme に当てる処理。画面の store と、描く前に先当てする static/theme-init.js の両方がこの値を使う
// （static/theme-init.js は import できないので、値の一致は scripts/theme.test.ts が確かめる）。
// scripts/ と Worker の型の検査からも読むので、Node の型の除去で動く書き方に留め（enum を使わない）、DOM の型に頼らない。
import type { DictionaryKey } from './vocabulary.ts';

// 自分で選べるテーマ（users.theme）。属性がなければシンプル（自動）。modern の名前はネオン（値は前の名前のまま）。
// DB の CHECK はほかに medieval（消した中世風）も許すが、アプリは書かない（0027 のマイグレーションが NULL に戻した）
export const themes = ['simple', 'simple_light', 'simple_dark', 'modern'] as const;
export type Theme = (typeof themes)[number];

// users.theme の値を、画面に返すテーマにする。選んでいない（NULL）と、アプリが書かない値（消した medieval）は simple
export function themeOf(value: string | null): Theme {
  return themes.find((theme) => theme === value) ?? 'simple';
}

// テーマを選ぶ画面（マイプロフィールのテーマ）が使う、テーマごとの辞書のキー。全テーマに辞書の名前があることを
// scripts/theme.test.ts が確かめる（テーマを足したとき、辞書の名前の足し忘れを止める）
export const themeLabelKeys: Record<Theme, DictionaryKey> = {
  simple: 'themeSimple',
  simple_light: 'themeSimpleLight',
  simple_dark: 'themeSimpleDark',
  modern: 'themeModern',
};

// テーマごとの説明の辞書のキー。中身は見本の design/kit.js の THEME_NOTE と同じ文（scripts/design-parity.test.ts が突き合わせる）
export const themeNoteKeys: Record<Theme, DictionaryKey> = {
  simple: 'themeNoteSimple',
  simple_light: 'themeNoteSimpleLight',
  simple_dark: 'themeNoteSimpleDark',
  modern: 'themeNoteModern',
};

// 描く前に読むので、static/theme-init.js と同じキーにする
export const themeStorageKey = 'sg-theme';

// document.documentElement の形のうち、使う部分だけ
export type ThemeTarget = { dataset: { theme?: string } };

// null は属性なし（シンプル（自動））
export function applyTheme(theme: Theme | null, target: ThemeTarget): void {
  if (theme) target.dataset.theme = theme;
  else delete target.dataset.theme;
}

// localStorage の形のうち、使う部分だけ（Worker の型には DOM の Storage が無い）
export type ThemeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// 覚えた値を読むのは、描く前の static/theme-init.js だけ（画面の側では読まない）
export function storeTheme(storage: Pick<ThemeStorage, 'setItem' | 'removeItem'>, theme: Theme | null): void {
  try {
    if (theme) storage.setItem(themeStorageKey, theme);
    else storage.removeItem(themeStorageKey);
  } catch {
    // 覚えられなくても、この画面の間は当たっている
  }
}
