// #1225: 消えるスクリプト glob と fish の連結 init の本文。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1225-shell-options' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// コマンド本体は実行しない。
for (const command of [
  `bash scripts/not-present/* -c 'git push --no-verify origin HEAD:main'`,
  `fish -C='git push origin main' -c 'printf ok'`,
]) {
  test(`[すり抜け] ${command}`, () => assert.equal(decision(command), 'ask', command));
}
for (const command of [
  'bash "scripts/$FILE" -c release',
  'bash scripts/tool.sh -c release',
  `bash -c 'printf ok'`,
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}
