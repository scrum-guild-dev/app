import { describe, expect, test } from 'vitest';
import { parseWikiFrontmatter, wikiBodyProblem, wikiTitle } from './wiki.ts';

describe('Wiki の題と安全な frontmatter', () => {
  test('非有限数を null と区別して、配列と入れ子でも保つ', () => {
    expect(
      parseWikiFrontmatter(
        '---\npositive: .inf\nnegative: -.inf\nunknown: .nan\nnested: {values: [.inf, -.inf, .nan, null]}\n---\n本文',
      ).properties,
    ).toEqual([
      { key: 'positive', value: 'Infinity' },
      { key: 'negative', value: '-Infinity' },
      { key: 'unknown', value: 'NaN' },
      { key: 'nested', value: '{\n  "values": [\n    "Infinity",\n    "-Infinity",\n    "NaN",\n    null\n  ]\n}' },
    ]);
  });
  test('title を除く任意のキーと値を文字として返す', () => {
    expect(
      parseWikiFrontmatter(
        '---\ntitle: 手順\nowner: 青葉\nreviewed: 2026-11-03\nactive: false\ncount: 0\nempty: null\nblank: ""\n---\n本文',
      ),
    ).toEqual({
      title: '手順',
      body: '本文',
      invalid: false,
      properties: [
        { key: 'owner', value: '青葉' },
        { key: 'reviewed', value: '2026-11-03' },
        { key: 'active', value: 'false' },
        { key: 'count', value: '0' },
        { key: 'empty', value: 'null' },
        { key: 'blank', value: '' },
      ],
    });
  });
  test('配列と入れ子を JSON の文字にし、複数行の文字列は保つ', () => {
    expect(
      parseWikiFrontmatter('---\npeople: [青葉, 若葉]\nreview:\n  done: true\nnotes: |\n  一行目\n  二行目\n---\n本文')
        .properties,
    ).toEqual([
      { key: 'people', value: '[\n  "青葉",\n  "若葉"\n]' },
      { key: 'review', value: '{\n  "done": true\n}' },
      { key: 'notes', value: '一行目\n二行目\n' },
    ]);
  });
  test.each(['本文', '---\ntitle: 題\n---\n本文'])('表に出す値が無ければ空の一覧を返す', (source) => {
    expect(parseWikiFrontmatter(source).properties).toEqual([]);
  });
  test.each([
    ['123', '123'],
    ['true', 'true'],
    ['null', 'null'],
    ['""', ''],
    ['" "', ' '],
    ['"' + '長'.repeat(101) + '"', '長'.repeat(101)],
  ])('題に使えない title %s も表に残す', (yaml, value) => {
    expect(parseWikiFrontmatter(`---\ntitle: ${yaml}\n---\n本文`).properties).toEqual([{ key: 'title', value }]);
  });
  test('BOM と CRLF の frontmatter を読み、本文から除く', () => {
    expect(parseWikiFrontmatter('\uFEFF---\r\nowner: 青葉\r\n---\r\n本文')).toEqual({
      title: null,
      body: '本文',
      invalid: false,
      properties: [{ key: 'owner', value: '青葉' }],
    });
  });
  test.each(['[a, b]', 'plain text', 'owner: [', 'owner: 青葉\nowner: 若葉'])(
    '表にできない YAML は全文を保って表を出さない: %s',
    (yaml) => {
      const source = `---\n${yaml}\n---\n本文`;
      expect(parseWikiFrontmatter(source)).toEqual({ title: null, body: source, invalid: true, properties: [] });
    },
  );
  test('空の frontmatter は本文から外し、入力の題を使う', () => {
    expect(parseWikiFrontmatter('---\n---\n本文')).toEqual({
      title: null,
      body: '本文',
      invalid: false,
      properties: [],
    });
    expect(wikiTitle('入力', '---\n---\n本文')).toBe('入力');
  });
  test('有効な title を使い、本文の保存値は呼び出し元に残す', () => {
    expect(wikiTitle('', '---\ntitle: "手順: 開発"\nowner: 青葉\n---\n本文')).toBe('手順: 開発');
    expect(parseWikiFrontmatter('---\ntitle: 題\n---\n本文').body).toBe('本文');
  });
  test.each(['true', '123', '" "', '"' + '長'.repeat(101) + '"'])('無効な題 %s は入力の題へ戻す', (title) => {
    expect(wikiTitle(' 入力 ', `---\ntitle: ${title}\n---\n本文`)).toBe('入力');
  });
  test.each(['title: [', 'title: !evil value', 'a: &a [one]\ntitle: *a', 'a: '.concat('['.repeat(20), ']'.repeat(20))])(
    '安全に読めない YAML を本文のまま返す',
    (yaml) => {
      const body = `---\n${yaml}\n---\n本文`;
      expect(parseWikiFrontmatter(body)).toEqual({ title: null, body, invalid: true, properties: [] });
      expect(wikiTitle('入力', body)).toBe('入力');
    },
  );
  test.each(['title: !!str 123', '!!map {title: hi}', 'title: !<tag:yaml.org,2002:str> 123'])(
    '明示タグを断る %s',
    (yaml) => {
      expect(parseWikiFrontmatter(`---\n${yaml}\n---\n本文`).invalid).toBe(true);
    },
  );
  test('引用された ! は普通の文字列として使える', () => {
    expect(wikiTitle('入力', '---\ntitle: "!手順"\n---\n本文')).toBe('!手順');
  });
  test('長すぎる YAML と閉じていない YAML を拒み、本文を保持する', () => {
    expect(parseWikiFrontmatter('---\ntitle: ' + 'a'.repeat(17000) + '\n---\n').invalid).toBe(true);
    expect(parseWikiFrontmatter('---\ntitle: 題').invalid).toBe(true);
  });
  test('コードポイントで長さを数え、NUL と不正なサロゲートを断る', () => {
    expect(wikiTitle('😀'.repeat(100), '')).toBe('😀'.repeat(100));
    expect(wikiTitle('😀'.repeat(101), '')).toBeNull();
    expect(wikiTitle('題\0', '')).toBeNull();
    expect(wikiBodyProblem('😀'.repeat(100000))).toBeNull();
    expect(wikiBodyProblem('😀'.repeat(100001))).toBe('too_long');
    expect(wikiBodyProblem('\0')).toBe('invalid_character');
    expect(wikiBodyProblem('\ud800')).toBe('invalid_character');
  });
});
