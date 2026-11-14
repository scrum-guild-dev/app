// #1225: fish の本文後にも解釈される option と展開を、安全な引数と混同しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1225-shell-options' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// いずれもフックの判定のみで、本文や git 自体は実行しない。
for (const command of [
  `fish -c 'printf ok' -C -- -c 'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf ok' $X 'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf ok' "$X" 'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf ok' $(echo -c) 'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf ok' -c'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf ok' -lc'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf ok' -C'git push --no-verify origin HEAD:main'`,
  `fish -lc 'printf first' -lc 'printf second'`,
  `fish -c 'printf first' -c 'printf second' -c 'printf third'`,
  `fish --com 'printf ok'`,
  `fish --com 'git push --no-verify origin HEAD:main'`,
]) {
  test(`[確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
}

for (const command of [
  `fish -c 'printf ok' -- -c 'git push --no-verify origin HEAD:main'`,
  `fish -c 'printf ok' -- "$X"`,
]) {
  test(`[引数] ${command}`, () => assert.equal(decision(command), 'allow', command));
}

test('先頭の本文に明確な拒否があれば、複数本文の確認に弱めない', () => {
  const first = `fish -c 'git push origin main'`;
  assert.equal(decision(first), 'deny');
  assert.equal(decision(`${first} -c 'printf ok'`), 'deny');
});

// 完全な長い option は両方の本文を個別に点検できるので、後ろの危険本文を見落とさないことを確認する。
test('長い --command の2つ目の本文にも判定を掛ける', () => {
  const command = `fish --command 'printf first' --command 'git push --no-verify origin HEAD:main'`;
  assert.notEqual(decision(command), 'allow', command);
});
