import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import WikiContent from './WikiContent.svelte';

// Svelte の描画用コメントを外し、利用者に出る要素と文字を比較する。
const html = (source: string) => render(WikiContent, { props: { source } }).body.replace(/<!--[\s\S]*?-->/g, '');

describe('Wiki の frontmatter と本文', () => {
  test('題を除いたキーと値を、本文より前の表に出す', () => {
    const out = html('---\ntitle: 表に出さない題\nowner: 青葉\n---\nページの本文');
    expect(out).toContain('<caption class="visually-hidden">ページの frontmatter（題を除く）</caption>');
    expect(out).toContain('<th scope="row">owner</th><td>青葉</td>');
    expect(out.indexOf('<table')).toBeLessThan(out.indexOf('ページの本文'));
    expect(out).not.toContain('表に出さない題');
    expect(out).not.toContain('owner: 青葉');
  });
  test('HTML、Markdown、配列と入れ子は文字として出す', () => {
    const out = html(
      '---\n"<img>": "<script>alert(1)</script>"\nlink: "[担当](https://example.test)"\nlist: [a, b]\nnested: {done: true}\n---\n本文',
    );
    expect(out).toContain('&lt;img>');
    expect(out).toContain('&lt;script>alert(1)&lt;/script>');
    expect(out).toContain('[担当](https://example.test)');
    expect(out).toContain('[\n  "a",\n  "b"\n]');
    expect(out).toContain('{\n  "done": true\n}');
    expect(out).not.toMatch(/<(?:img|script|a)[\s>]/);
  });
  test('空の文字列は注記を出し、null と区別する', () => {
    const out = html('---\nblank: ""\nempty: null\n---\n本文');
    expect(out).toContain('<span class="props-note">（空）</span>');
    expect(out).toContain('<td>null</td>');
  });
  test('題に使えない title は表で読める', () => {
    expect(html('---\ntitle: 123\n---\n本文')).toContain('<th scope="row">title</th><td>123</td>');
  });
  test('読めない YAML は警告と元の全文を出す', () => {
    const out = html('---\nowner: [\n---\n残す本文');
    expect(out).toContain('frontmatter を読めません');
    expect(out).toContain('owner: [');
    expect(out).toContain('残す本文');
    expect(out).not.toContain('<table');
  });
  test.each(['本文だけ', '---\n---\n本文', '---\ntitle: 題\n---\n本文'])(
    '値の無いページは表と警告を出さない: %s',
    (source) => {
      const out = html(source);
      expect(out).not.toContain('<table');
      expect(out).not.toContain('frontmatter を読めません');
      expect(out).toContain('本文');
    },
  );
});
