import { expect, test } from 'vitest';
import { parseWikiFrontmatter, wikiTitle } from './wiki.ts';
import { wikiDownloadName, wikiDownloadSource, wikiUploadProblem } from './wiki-transfer.ts';

test('使えるtitleを持つ本文はBOM・CRLF・コメントごとそのまま書き出す', () => {
  const source = '\uFEFF---\r\n# memo\r\ntitle: 手順\r\nowner: 青葉\r\n---\r\n本文\r\n';
  expect(wikiDownloadSource('手順', source)).toBe(source);
});
test.each(['本文\r\n', '本文\n---\nowner: 青葉\n---\n後半', '---\n---\n本文'])(
  '題を安全な引用文字列で足す: %s',
  (source) => {
    const title = '[重要]: #1 "確認"';
    const result = wikiDownloadSource(title, source);
    expect(wikiTitle('別のファイル名', result)).toBe(title);
    expect(parseWikiFrontmatter(result).body).toBe(
      source === '---\n---\n本文' ? '本文' : source.replace(/\r\n/g, '\n'),
    );
  },
);
test.each(['', 'title: 123\n', 'title: " "\n'])('無効なtitleを置き換え、他のキーと本文を保つ: %s', (title) => {
  const source = `---\n${title}owner: 青葉\nnested: { values: [true, 123, .inf, null] }\n---\n本文\r\n`;
  const result = wikiDownloadSource('題', source);
  const parsed = parseWikiFrontmatter(result);
  expect(parsed.title).toBe('題');
  expect(parsed.body).toBe('本文\n');
  expect(parsed.properties).toEqual(parseWikiFrontmatter(source).properties.filter((item) => item.key !== 'title'));
  expect(result.endsWith('本文\r\n')).toBe(true);
});
test.each(['---\nowner: [\n---\n本文', '---\ntitle: 未完', '---\na: &a [1]\nb: *a\n---\n本文'])(
  '読めないYAMLは補完せず全文を保持する',
  (source) => {
    expect(wikiDownloadSource('題', source)).toBe(source);
  },
);
test('ファイル名は道筋・制御文字・予約名を避け、拡張子を含め100字にする', () => {
  expect(wikiDownloadName('../手順/\\:*?"<>|\0')).toBe('..手順.md');
  expect(wikiDownloadName('CON')).toBe('_CON.md');
  expect(wikiDownloadName('/')).toBe('page.md');
  expect([...wikiDownloadName('😀'.repeat(100))]).toHaveLength(100);
});
test('ファイル名と内容を共通のルールで検証する', () => {
  expect(wikiUploadProblem({ file_name: '題.MD', body_md: '' })).toBeNull();
  expect(wikiUploadProblem({ file_name: '.md', body_md: '' })).toBe('title');
  expect(wikiUploadProblem({ file_name: '題.txt', body_md: '' })).toBe('extension');
  expect(wikiUploadProblem({ file_name: '題.md', body_md: '\ud800' })).toBe('invalid_character');
});
test('16MiBの要求に収まる巨大な不正入力も拒否できる', () => {
  expect(wikiUploadProblem({ file_name: 'a'.repeat(12_000_000) + '.md', body_md: '' })).toBe('file_name');
  expect(wikiUploadProblem({ file_name: '題.md', body_md: 'a'.repeat(12_000_000) })).toBe('too_long');
});
test.each([3000, 6000])('配列を含むfrontmatterを膨張させず、題の補完後も読める: %i', (count) => {
  const source = '---\nitems: [' + Array(count).fill('a').join(',') + ']\n---\n本文';
  const output = wikiDownloadSource('手順', source);
  expect(parseWikiFrontmatter(output).invalid).toBe(false);
  expect(parseWikiFrontmatter(output).title).toBe('手順');
  expect(parseWikiFrontmatter(output).properties).toEqual(parseWikiFrontmatter(source).properties);
});
