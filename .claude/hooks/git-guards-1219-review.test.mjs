// #1219: シェルの連結オプションと、コマンドを実行しない通常の制御・道具。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1219-guard-exec' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
// 本文や git は実行せず、判定だけを行う。
for (const command of [
  `bash -co pipefail 'git push --no-verify origin HEAD:main'`,
  `bash -ceo pipefail 'git push --no-verify origin HEAD:main'`,
  `bash -cO extglob 'git push --no-verify origin HEAD:main'`,
]) {
  test(`[すり抜け] ${command}`, () => assert.notEqual(decision(command), 'allow', command));
}

for (const command of [
  `bash -co pipefail 'printf ok'`,
  `bash -ceo pipefail 'printf ok'`,
  `bash -cO extglob 'printf ok'`,
  'for f in *.md; do echo "$f"; done',
  'select f in *.md; do break; done',
  'sleep "$n"',
  'kill $pid',
  'exit $?',
  'pgrep node',
  'tar czf x.tgz src/*',
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}
