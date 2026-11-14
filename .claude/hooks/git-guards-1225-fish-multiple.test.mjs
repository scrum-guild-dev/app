// #1225: fish の複数 -c は、先頭の本文だけで安全と判断しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1225-shell-options' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// 本文や git 自体は実行せず、複数本文の入口を保守的に確認する。
for (const command of [
  `fish -c 'printf ok' -c 'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf first' -c 'printf second'`,
]) {
  test(`[複数本文] ${command}`, () => assert.equal(decision(command), 'ask', command));
}
for (const command of [
  `fish -c 'printf ok'`,
  `fish -c 'printf ok' -- -c value`,
  'fish scripts/tool.fish -c release',
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}
