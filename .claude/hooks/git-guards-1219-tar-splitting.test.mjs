// #1219: 固定の接頭辞があっても、未引用の変数は tar の追加 option に分かれうる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1219-guard-exec' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// tar と追加されうる実行 option は実行せず、判定だけを確かめる。
for (const command of [
  'tar -cf out.tar src/$FILES',
  'tar -c --file=out$NAME src/*',
]) {
  test(`[語の分割] ${command}`, () => assert.equal(decision(command), 'ask', command));
}
for (const command of [
  'tar -cf out.tar "src/$FILES"',
  'tar -cf out.tar src/*',
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}
