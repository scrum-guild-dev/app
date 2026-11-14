// #293: シェルの glob と異なる Git の再帰 pathspec と実行時の対象。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => 'main' };
for (const command of ["git restore '*.mjs'", "git rm -- '*.mjs'", 'git restore "$P"']) {
  test(`[すり抜け] ${command}`, () => assert.notEqual(judgeBash(command, context)?.[0] ?? 'allow', 'allow', command));
}
for (const command of ['git restore docs/readme.md', 'git diff -- "*.mjs"']) {
  test(`[通す] ${command}`, () => assert.equal(judgeBash(command, context)?.[0] ?? 'allow', 'allow', command));
}
