import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { toolbarEdit, type MarkdownFormat } from '../src/lib/markdown-toolbar.ts';

const kit = readFileSync(new URL('../design/kit.js', import.meta.url), 'utf8');
const start = kit.indexOf('function toolbarEdit(');
const end = kit.indexOf('function createSheetHtml(', start);
assert.ok(start >= 0 && end > start, '見本の書式処理がある');
const designEdit = runInNewContext(`${kit.slice(start, end)}; toolbarEdit`) as typeof toolbarEdit;

for (const [value, from, to] of [
  ['', 0, 0],
  ['本文\n次の行', 1, 1],
  ['一行\n二行\n残す行', 0, 6],
  ['　- 項目', 3, 3],
  ['- [x] 済み', 6, 6],
  ['```\na\n```\ntext', 10, 10],
  ['```\na\n```\n\n```\nb\n```', 15, 15],
  ['```\na\nb\n```', 4, 4],
  ['a\n```\nb', 6, 6],
  ['```\na\n```', 4, 7],
] as const) {
  test(`見本の4書式が本番と一致する: ${JSON.stringify(value)} (${from}, ${to})`, () => {
    for (const format of ['bullet', 'todo', 'code', 'quote'] satisfies MarkdownFormat[]) {
      const expected = toolbarEdit(value, from, to, format);
      const actual = designEdit(value, from, to, format);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected));
      const after = value.slice(0, actual.start) + actual.text + value.slice(actual.end);
      assert.equal(
        JSON.stringify(designEdit(after, actual.selectionStart, actual.selectionEnd, format)),
        JSON.stringify(toolbarEdit(after, expected.selectionStart, expected.selectionEnd, format)),
      );
    }
  });
}
