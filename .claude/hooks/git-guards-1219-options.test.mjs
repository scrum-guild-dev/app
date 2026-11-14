// #1219: シェルの o/O は c の前後や同じ語の複数箇所でも値を取る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1219-guard-exec' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
const options = [
  '-oc pipefail',
  '-coe pipefail',
  '-coo pipefail errexit',
  '-Oc extglob',
  '-c -oo pipefail errexit',
];
for (const flags of options) {
  const command = `bash ${flags} 'git push --no-verify origin HEAD:main'`;
  // 本文や git は実行せずフックの判定だけを確かめる。
  test(`[すり抜け] ${command}`, () => assert.notEqual(decision(command), 'allow', command));
  const safe = `bash ${flags} 'printf ok'`;
  test(`[通す] ${safe}`, () => assert.equal(decision(safe), 'allow', safe));
}

// 動的な宛先や固定の接頭辞がない glob は、人が確かめる既存の境界を維持する。
for (const command of [
  'tar czf "$OUT" src',
  'tar -xf x.tar -C "$DEST"',
  'tar cf x.tar *.md',
]) {
  test(`[確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
}
