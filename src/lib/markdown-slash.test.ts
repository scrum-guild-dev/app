import { describe, expect, test } from 'vitest';
import { word } from '../shared/vocabulary.ts';
import { SLASH_ITEMS, filterSlashItems, moveSlashSelection, slashEdit, slashQuery } from './markdown-slash.ts';

const labelOf = (item: (typeof SLASH_ITEMS)[number]) => word(item.label);

describe('小窓が出る条件', () => {
  test('行頭の「/」で出る', () => {
    expect(slashQuery('/', 1, 1)).toEqual({ from: 0, query: '' });
    expect(slashQuery('前の行\n/', 5, 5)).toEqual({ from: 4, query: '' });
  });

  test('続けて打った文字を絞り込みの文字にする', () => {
    expect(slashQuery('/見出', 3, 3)).toEqual({ from: 0, query: '見出' });
    expect(slashQuery('/todo', 5, 5)).toEqual({ from: 0, query: 'todo' });
  });

  test('先頭の空白（字下げ）の後でも出し、置き換えは「/」から', () => {
    expect(slashQuery('  /', 3, 3)).toEqual({ from: 2, query: '' });
    expect(slashQuery('\t　/h', 4, 4)).toEqual({ from: 2, query: 'h' });
  });

  test('文中の「/」では出ない', () => {
    expect(slashQuery('a/', 2, 2)).toBeNull();
    expect(slashQuery('a /', 3, 3)).toBeNull();
    expect(slashQuery('https://example.com', 19, 19)).toBeNull();
    expect(slashQuery('- /', 3, 3)).toBeNull();
  });

  test('「/」の後に空白や「/」が来たら出ない', () => {
    expect(slashQuery('/a b', 4, 4)).toBeNull();
    expect(slashQuery('/a ', 3, 3)).toBeNull();
    expect(slashQuery('//', 2, 2)).toBeNull();
    expect(slashQuery('/　', 2, 2)).toBeNull();
  });

  test('カーソルが「/」の行の外か手前にあるときは出ない', () => {
    expect(slashQuery('/\n次の行', 3, 3)).toBeNull();
    expect(slashQuery('/見出し', 0, 0)).toBeNull();
    expect(slashQuery('', 0, 0)).toBeNull();
  });

  test('範囲を選んでいるときは出ない', () => {
    expect(slashQuery('/見出し', 0, 4)).toBeNull();
    expect(slashQuery('/見出し', 1, 4)).toBeNull();
  });

  test('カーソルより後ろの文字は絞り込みに入れない', () => {
    expect(slashQuery('/見出し', 2, 2)).toEqual({ from: 0, query: '見' });
  });
});

describe('候補', () => {
  test('見出し、チェックリスト、箇条書き、番号付きの一覧、引用、コードの6つ', () => {
    expect(SLASH_ITEMS.map(labelOf)).toEqual([
      '見出し',
      'チェックリスト',
      '箇条書き',
      '番号付きの一覧',
      '引用',
      'コード',
    ]);
  });

  test('空の絞り込みは全件', () => {
    expect(filterSlashItems('', labelOf)).toHaveLength(6);
  });

  test('名前の部分一致と英字の前方一致（大文字小文字を問わない）で絞る', () => {
    expect(filterSlashItems('見', labelOf).map((item) => item.key)).toEqual(['heading']);
    expect(filterSlashItems('一覧', labelOf).map((item) => item.key)).toEqual(['ordered']);
    expect(filterSlashItems('H', labelOf).map((item) => item.key)).toEqual(['heading']);
    expect(filterSlashItems('to', labelOf).map((item) => item.key)).toEqual(['todo']);
    expect(filterSlashItems('l', labelOf).map((item) => item.key)).toEqual(['bullet']);
  });

  test('一致が無ければ空（小窓を閉じる）', () => {
    expect(filterSlashItems('zzz', labelOf)).toEqual([]);
  });

  test('矢印キーで選ぶ位置は端で反対側へ回る', () => {
    expect(moveSlashSelection(0, 6, -1)).toBe(5);
    expect(moveSlashSelection(5, 6, 1)).toBe(0);
    expect(moveSlashSelection(2, 6, 1)).toBe(3);
    expect(moveSlashSelection(0, 0, 1)).toBe(0);
  });
});

describe('置き換え', () => {
  const apply = (value: string, caret: number, key: (typeof SLASH_ITEMS)[number]['key']) => {
    const query = slashQuery(value, caret, caret);
    const item = SLASH_ITEMS.find((candidate) => candidate.key === key);
    if (query === null || item === undefined) throw new Error('前提が成り立たない');
    const edit = slashEdit(query, caret, item);
    return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), caret: edit.caret };
  };

  test('「/」と絞り込みの文字を Markdown の記号に置き換え、書く位置にカーソルを置く', () => {
    expect(apply('/見出', 3, 'heading')).toEqual({ value: '## ', caret: 3 });
    expect(apply('/', 1, 'todo')).toEqual({ value: '- [ ] ', caret: 6 });
    expect(apply('/', 1, 'bullet')).toEqual({ value: '- ', caret: 2 });
    expect(apply('/', 1, 'ordered')).toEqual({ value: '1. ', caret: 3 });
    expect(apply('/', 1, 'quote')).toEqual({ value: '> ', caret: 2 });
  });

  test('コードは囲みの間にカーソルを置く', () => {
    const result = apply('/', 1, 'code');
    expect(result.value).toBe('```\n\n```');
    expect(result.value.slice(0, result.caret)).toBe('```\n');
  });

  test('行の途中の文字の前で「コード」を選ぶと、続く文字は閉じの囲みの外の次の行に出す', () => {
    const query = slashQuery('/既存', 1, 1);
    const code = SLASH_ITEMS.find((candidate) => candidate.key === 'code');
    if (query === null || code === undefined) throw new Error('前提が成り立たない');
    const edit = slashEdit(query, 1, code, '既');
    const value = '/既存'.slice(0, edit.start) + edit.text + '/既存'.slice(edit.end);
    expect(value).toBe('```\n\n```\n既存');
    // 行末や改行の前なら足さない
    expect(slashEdit(query, 1, code, '\n').text).toBe('```\n\n```');
    expect(slashEdit(query, 1, code, '').text).toBe('```\n\n```');
  });

  test('前後の行と字下げは残す', () => {
    expect(apply('前の行\n  /to', 10, 'todo')).toEqual({ value: '前の行\n  - [ ] ', caret: 12 });
  });
});
