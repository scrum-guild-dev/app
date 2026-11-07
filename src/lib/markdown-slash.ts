// Markdown の欄の「/」の小窓。出す条件、候補の絞り込み、置き換えを DOM から切り離して持つ（欄は MarkdownEditor.svelte）。
// 見本は design/kit.js の SLASH_ITEMS と slashQuery。

import type { DictionaryKey } from '../shared/vocabulary.ts';

export type SlashItemKey = 'heading' | 'todo' | 'bullet' | 'ordered' | 'quote' | 'code';

export type SlashItem = {
  key: SlashItemKey;
  /** 候補の名前（言葉の辞書のキー）。 */
  label: DictionaryKey;
  /** 候補の横に出す記号。 */
  mark: string;
  /** 「/」と絞り込みの文字の代わりに入れる Markdown。 */
  markdown: string;
  /** 入れた Markdown の先頭からのカーソルの位置。 */
  caret: number;
  /** 絞り込みで名前のほかに合わせる英字。 */
  aliases: readonly string[];
};

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    key: 'heading',
    label: 'slashHeading',
    mark: '#',
    markdown: '## ',
    caret: 3,
    aliases: ['h', 'h1', 'h2', 'heading'],
  },
  { key: 'todo', label: 'slashTodo', mark: '[ ]', markdown: '- [ ] ', caret: 6, aliases: ['todo', 'check', 'task'] },
  { key: 'bullet', label: 'slashBullet', mark: '-', markdown: '- ', caret: 2, aliases: ['ul', 'list', 'bullet'] },
  {
    key: 'ordered',
    label: 'slashOrdered',
    mark: '1.',
    markdown: '1. ',
    caret: 3,
    aliases: ['ol', 'number', 'ordered'],
  },
  { key: 'quote', label: 'slashQuote', mark: '>', markdown: '> ', caret: 2, aliases: ['quote'] },
  { key: 'code', label: 'slashCode', mark: '```', markdown: '```\n\n```', caret: 4, aliases: ['code'] },
];

export type SlashQuery = {
  /** 「/」の位置。置き換えはここから、カーソルまで。 */
  from: number;
  /** 「/」の後ろから、カーソルまでの文字。 */
  query: string;
};

// 行頭（先頭の空白は許す）の「/」から、空白を含まない文字がカーソルまで続くときだけ小窓を出す。
// 文中の「/」と、範囲を選んでいるときは出さない。Markdown の記号は行頭でしか効かないため。
export function slashQuery(value: string, start: number, end: number): SlashQuery | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const match = /^(\s*)\/([^\s/]*)$/u.exec(value.slice(lineStart, start));
  if (match === null) return null;
  return { from: lineStart + (match[1] ?? '').length, query: match[2] ?? '' };
}

// 絞り込みは名前の部分一致か、英字の前方一致（大文字と小文字は区別しない）。空なら6つすべて。
export function filterSlashItems(query: string, labelOf: (item: SlashItem) => string): SlashItem[] {
  if (query === '') return [...SLASH_ITEMS];
  const lower = query.toLowerCase();
  return SLASH_ITEMS.filter(
    (item) => labelOf(item).includes(query) || item.aliases.some((alias) => alias.startsWith(lower)),
  );
}

/** 選んだ候補で、「/」から絞り込みの文字（カーソルまで）を置き換える編集と、その後のカーソルの位置。 */
export function slashEdit(
  query: SlashQuery,
  caret: number,
  item: SlashItem,
): { start: number; end: number; text: string; caret: number } {
  return { start: query.from, end: caret, text: item.markdown, caret: query.from + item.caret };
}

/** 矢印キーで選ぶ位置。端で反対側へ回る。 */
export function moveSlashSelection(at: number, count: number, delta: 1 | -1): number {
  return count === 0 ? 0 : (at + delta + count) % count;
}
