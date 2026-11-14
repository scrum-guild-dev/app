// #1219: tar の通常アーカイブ例外でも、実行する flag と動的な flag は確認する。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1219-guard-exec' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// tar 自体や設定されたコマンドは実行しない。
for (const command of [
  'tar --to-com="$CMD" -xf x.tar',
  'tar "$OPT" -xf x.tar',
  'tar -I "$CMD" -xf x.tar',
  'tar --checkpoint-act="$ACTION" -xf x.tar',
]) {
  test(`[確認] ${command}`, () => assert.equal(decision(command), 'ask', command));
}

test('[通す] 通常のアーカイブ作成', () => assert.equal(decision('tar -cf x.tar src/*'), 'allow'));
