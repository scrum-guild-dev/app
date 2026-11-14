// #1225: fish の連結 init、bash の単独 -、動的 option とスクリプト引数の境界。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1225-shell-options' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// fish は -Cfoo を初期コマンドとして扱い、後ろの -c も実行する。本文自体は実行しない。
for (const command of [
  `fish -Cfoo -c 'git push --no-verify origin HEAD:main'`,
  `bash -c - 'git push --no-verify origin HEAD:main'`,
  `F=c; bash -$F 'git push --no-verify origin HEAD:main'`,
  `bash "$FLAG" 'git push --no-verify origin HEAD:main'`,
  `bash +o errexit -c 'git push --no-verify origin HEAD:main'`,
  `bash +O extglob -c 'git push --no-verify origin HEAD:main'`,
]) {
  test(`[すり抜け] ${command}`, () => assert.notEqual(decision(command), 'allow', command));
}

for (const command of [
  `bash -c - 'printf ok'`,
  `fish -lc 'printf ok'`,
  'bash ./script.sh -c release',
  'bash scripts/tool.sh "$ARG"',
  `bash +o errexit -c 'printf ok'`,
  `bash +O extglob -c 'printf ok'`,
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}

// 未知の option は本文の位置を確定せず、人が確認する。
for (const command of [
  `bash --unknown -c 'printf ok'`,
]) {
  test(`[不明な option] ${command}`, () => assert.equal(decision(command), 'ask', command));
}
