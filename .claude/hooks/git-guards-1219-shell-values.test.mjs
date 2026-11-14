// #1219: シェルの option 値にある c/o を実行フラグと数えない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => '1219-guard-exec' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';
for (const option of ['--rcfile', '--init-file']) {
  const command = `bash ${option} -coo -c 'git push --no-verify origin HEAD:main'`;
  // git や危険な本文自体は実行しない。
  test(`[すり抜け] ${command}`, () => assert.notEqual(decision(command), 'allow', command));
  const safe = `bash ${option} -coo -c 'printf ok'`;
  test(`[通す] ${safe}`, () => assert.equal(decision(safe), 'allow', safe));
}
