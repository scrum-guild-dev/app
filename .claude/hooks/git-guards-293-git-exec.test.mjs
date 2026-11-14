// #293: git 自身が別のコマンドやシェル本文を実行する入口。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '293-hook-guards' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// git や本文は実行しない。作業ブランチでの main 判定に隠れないことを確かめる。
for (const command of [
  `git rebase -x 'git push origin main' HEAD~1`,
  `git rebase --exec 'git push origin main' HEAD~1`,
  `git rebase -x'git push origin main' HEAD~1`,
  `git rebase --exec='git push origin main' HEAD~1`,
  'git rebase --exec "$CMD" HEAD~1',
  'git bisect run git push origin main',
  'git bisect run "$TOOL"',
  `git submodule foreach 'git push origin main'`,
  `git submodule foreach --recursive 'git push origin main'`,
  'git submodule foreach "$CMD"',
  `git difftool --extcmd 'git push origin main' HEAD`,
  `git difftool --extcmd='git push origin main' HEAD`,
  `git difftool -x 'git push origin main' HEAD`,
  'git difftool -x "$CMD" HEAD',
]) {
  test(`[実行経路] ${command}`, () => assert.notEqual(decision(command), 'allow', command));
}

for (const command of [
  'git rebase --show-current-patch',
  'git bisect log',
  'git submodule status',
  'git submodule status --recursive',
  'git difftool -- docs/readme.md',
  'git diff -- docs/readme.md',
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}
