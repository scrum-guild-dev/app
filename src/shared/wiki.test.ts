import { describe, expect, test } from 'vitest';
import { parseWikiFrontmatter, wikiBodyProblem, wikiTitle } from './wiki.ts';

describe('Wiki の題と安全な frontmatter', () => {
  test('空の frontmatter は本文から外し、入力の題を使う', () => {
    expect(parseWikiFrontmatter('---\n---\n本文')).toEqual({ title: null, body: '本文', invalid: false });
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
      expect(parseWikiFrontmatter(body)).toEqual({ title: null, body, invalid: true });
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
