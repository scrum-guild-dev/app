import { expect, test } from 'vitest';
import { toolbarEdit, type MarkdownFormat } from './markdown-toolbar.ts';

function apply(value: string, from: number, to: number, format: MarkdownFormat) {
  const edit = toolbarEdit(value, from, to, format);
  return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), ...edit };
}

for (const [format, prefix] of [
  ['bullet', '- '],
  ['todo', '- [ ] '],
  ['quote', '> '],
] as const) {
  test(`${format}: カーソルの行だけに付け、再度押すと外す`, () => {
    const added = apply('前\n本文\n後', 4, 4, format);
    expect(added.value).toBe(`前\n${prefix}本文\n後`);
    expect(added.selectionStart).toBe(4 + prefix.length);
    const removed = apply(added.value, added.selectionStart, added.selectionEnd, format);
    expect(removed.value).toBe('前\n本文\n後');
    expect(removed.selectionStart).toBe(4);
  });
  test(`${format}: 複数行の選択を保ち、次の行頭で終わる選択は次の行を変えない`, () => {
    const added = apply('あいう\nえお\n後', 1, 7, format);
    expect(added.value).toBe(`${prefix}あいう\n${prefix}えお\n後`);
    const removed = apply(added.value, added.selectionStart, added.selectionEnd, format);
    expect(removed.value).toBe('あいう\nえお\n後');
    expect([removed.selectionStart, removed.selectionEnd]).toEqual([1, 7]);
  });
  test(`${format}: 空欄にも入れ、字下げを保ち、すでにある記号を重ねない`, () => {
    expect(apply('', 0, 0, format).value).toBe(prefix);
    const mixed = `  ${prefix}一行\n  二行`;
    const added = apply(mixed, 0, mixed.length, format);
    expect(added.value).toBe(`  ${prefix}一行\n  ${prefix}二行`);
  });
}

test('済みのチェックリストも外せ、箇条書きと区別する', () => {
  expect(apply('- [x] 済み\n- [ ] まだ', 0, 17, 'todo').value).toBe('済み\nまだ');
  expect(apply('- [ ] 箱', 7, 7, 'bullet').value).toBe('- - [ ] 箱');
});

test('記号の中にカーソルがあっても、外した後の選択を本文より前へ出さない', () => {
  const edit = apply('- [ ] 本文', 2, 7, 'todo');
  expect(edit.value).toBe('本文');
  expect([edit.selectionStart, edit.selectionEnd]).toEqual([0, 1]);
});

test('コードは現在の行全体を囲み、同じカーソルで外せる', () => {
  const added = apply('前\n実行する\n後', 4, 4, 'code');
  expect(added.value).toBe('前\n```\n実行する\n```\n後');
  const removed = apply(added.value, added.selectionStart, added.selectionEnd, 'code');
  expect(removed.value).toBe('前\n実行する\n後');
  expect(removed.selectionStart).toBe(4);
});

test('空のコードの囲みに書ける位置を置き、空のままでも外せる', () => {
  const added = apply('', 0, 0, 'code');
  expect(added.value).toBe('```\n\n```');
  expect(added.selectionStart).toBe(4);
  expect(apply(added.value, 4, 4, 'code').value).toBe('');
});

test('複数行と空行をコードで囲み、元の選択を保つ', () => {
  const original = '前\nあいう\n\nえお\n後';
  const added = apply(original, 3, 9, 'code');
  const removed = apply(added.value, added.selectionStart, added.selectionEnd, 'code');
  expect(removed.value).toBe(original);
  expect([removed.selectionStart, removed.selectionEnd]).toEqual([3, 9]);
});

test('本文中の囲みより長い囲みを使う', () => {
  const added = apply('例 ``` code', 2, 2, 'code');
  expect(added.value).toBe('````\n例 ``` code\n````');
  expect(apply(added.value, added.selectionStart, added.selectionEnd, 'code').value).toBe('例 ``` code');
});

test('言語付き・チルダの既存コードも囲みを外せる', () => {
  expect(apply('~~~ts\nconst x = 1;\n~~~', 7, 7, 'code').value).toBe('const x = 1;');
});

test('全角空白は字下げと誤認せず、記号を付け外しできる', () => {
  const added = apply('　- 項目', 3, 3, 'bullet');
  expect(added.value).toBe('- 　- 項目');
  expect(apply(added.value, added.selectionStart, added.selectionEnd, 'bullet').value).toBe('　- 項目');
});

test('未閉じコード内では既存の開始囲みを外し、囲みを増殖させない', () => {
  expect(apply('a\n```\nb', 6, 6, 'code').value).toBe('a\nb');
});

test('コード本文から閉じの途中まで選んでも、既存の囲みを外す', () => {
  expect(apply('```\na\n```', 4, 7, 'code').value).toBe('a');
});

test('コードの閉じを跨いで選ぶ場合はブロック全体を囲み、再押下で戻る', () => {
  const value = '```\na\n```\ntext';
  const added = apply(value, 4, value.length, 'code');
  expect(apply(added.value, added.selectionStart, added.selectionEnd, 'code').value).toBe(value);
});
