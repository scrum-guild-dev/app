import { expect, test } from 'vitest';
import { isWikiPageLink } from './wiki-link.ts';

test('同じオリジンの同じ Wiki のページだけを内部のリンクとして扱う', () => {
  const prefix = 'https://example.test/aoba/w/one/wiki/';
  const id = '019a0000-0000-7000-8000-000000000001';
  expect(isWikiPageLink(prefix + id, prefix)).toBe(true);
  expect(isWikiPageLink(prefix + id + '#section', prefix)).toBe(true);
  for (const href of [
    'https://other.test/aoba/w/one/wiki/' + id,
    'https://example.test/aoba/w/two/wiki/' + id,
    prefix + '../other',
    prefix + id + '/other',
  ]) {
    expect(isWikiPageLink(href, prefix)).toBe(false);
  }
  expect(isWikiPageLink(prefix + id)).toBe(false);
});
