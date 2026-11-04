import { describe, expect, it } from 'vitest';
import { clipboardTextToInsert } from './attachment-upload.ts';

describe('file clipboard text', () => {
  it('omits file-copy metadata for a single exact filename', () => {
    const files = [{ name: '手順.txt' }];
    expect(clipboardTextToInsert('手順.txt', files)).toBe('');
    expect(clipboardTextToInsert('手順.txt\n', files)).toBe('');
  });
  it('omits exact multiple filenames including CRLF and one final newline', () => {
    const files = [{ name: '手順.txt' }, { name: '画面.png' }];
    expect(clipboardTextToInsert('手順.txt\n画面.png', files)).toBe('');
    expect(clipboardTextToInsert('手順.txt\r\n画面.png\r\n', files)).toBe('');
  });
  it('preserves real text and replaces native textarea line endings only', () => {
    const files = [{ name: '手順.txt' }];
    expect(clipboardTextToInsert('貼った文章\r\n次の行', files)).toBe('貼った文章\n次の行');
    expect(clipboardTextToInsert('手順.txt\n説明', files)).toBe('手順.txt\n説明');
    expect(clipboardTextToInsert(' 手順.txt ', files)).toBe(' 手順.txt ');
    expect(clipboardTextToInsert('手順.txt\n\n', files)).toBe('手順.txt\n\n');
    expect(clipboardTextToInsert('手順.txt', [])).toBe('手順.txt');
  });
  it('keeps text whose filename sequence differs in order, spelling or case', () => {
    const files = [{ name: 'one.txt' }, { name: 'two.png' }];
    expect(clipboardTextToInsert('two.png\none.txt', files)).toBe('two.png\none.txt');
    expect(clipboardTextToInsert('One.txt\ntwo.png', files)).toBe('One.txt\ntwo.png');
    expect(clipboardTextToInsert('one.txt', files)).toBe('one.txt');
  });
  it('omits canonically equivalent Japanese filenames without normalizing real text', () => {
    const name = 'ガイド.pdf';
    const decomposed = name.normalize('NFD');
    expect(clipboardTextToInsert(decomposed, [{ name }])).toBe('');
    expect(clipboardTextToInsert(name, [{ name: decomposed }])).toBe('');
    expect(clipboardTextToInsert(`${decomposed}\r\n画面.png\r\n`, [{ name }, { name: '画面.png' }])).toBe('');
    const paragraph = `${decomposed}の説明`;
    expect(clipboardTextToInsert(paragraph, [{ name }])).toBe(paragraph);
  });
  it('keeps a newline when no files accompany the text', () => {
    expect(clipboardTextToInsert('\n', [])).toBe('\n');
    expect(clipboardTextToInsert('\r\n', [])).toBe('\n');
  });
});
