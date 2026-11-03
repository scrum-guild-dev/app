import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { restoreWikiPageSql } from './restore-wiki-page-sql.ts';

const org = '019a0000-0000-7000-8000-000000000001';
const page = '019a0000-0000-7000-8000-000000000002';
const script = fileURLToPath(new URL('./restore-wiki-page.ts', import.meta.url));
test('復元の CLI は書き出すだけで、改行の無い1文と末尾の改行を返す', () => {
  const result = spawnSync(process.execPath, [script, org, page], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, restoreWikiPageSql(org, page));
  assert.match(result.stdout, /^UPDATE wiki_pages AS p [^\n]+;\n$/);
  assert.doesNotMatch(result.stdout, /["$`\\!]/);
});
for (const args of [
  [],
  [org],
  [org, page, page],
  [org, `${page}' OR 1=1`],
  ['aoba', page],
  [org.toUpperCase(), page],
]) {
  test(`不正な引数${JSON.stringify(args)}から SQL を出さない`, () => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /使い方/);
  });
}
