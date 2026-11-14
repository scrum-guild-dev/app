// #293: 最新ベースとの統合後、設定した環境と表示した文字列を取り違えない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '293-hook-guards' };
const decision = (command, env = {}) => judgeBash(command, { ...context, env })?.[0] ?? 'allow';

for (const command of [
  'export GIT_CONFIG_KEY_0=core.hooksPath; bash -c "git status"',
  'printf -v GIT_CONFIG_PARAMETERS x; git status',
  'read GIT_CONFIG_COUNT; git status',
]) {
  test(`[すり抜け] ${command}`, () => assert.equal(decision(command), 'ask'));
}

for (const env of [{ GIT_CONFIG_GLOBAL: '/tmp/293-config' }, { GIT_CONFIG_KEY_0: 'core.hooksPath' }]) {
  test(`[セッションの設定] ${Object.keys(env)[0]}`, () => {
    const before = { ...env };
    assert.equal(decision('bash -c "git status"', env), 'ask');
    assert.deepEqual(env, before);
  });
}

for (const command of [
  'echo GIT_CONFIG_KEY_0=core.hooksPath; git status',
  'export PATH=$HOME/bin:$PATH; git status',
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow'));
}
