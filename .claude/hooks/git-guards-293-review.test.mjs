// #293: 独立レビューで見つかった省略形と再帰 chmod の回帰。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const repo = mkdtempSync(path.join(os.tmpdir(), '293-review-'));
execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '-b', 'main', repo]);
mkdirSync(path.join(repo, '.githooks'));
writeFileSync(path.join(repo, '.githooks/pre-commit'), '#!/bin/sh\nexit 0\n');
writeFileSync(path.join(repo, 'package.json'), '{}\n');
// 再帰 chmod のテストは判定だけを行い、fixture 自体の権限は変えない。
after(() => {
  chmodSync(repo, 0o700);
  rmSync(repo, { recursive: true, force: true });
});
const decision = (command) => judgeBash(command, { cwd: repo, branchOf: () => 'main' })?.[0] ?? 'allow';

for (const command of [
  'git config --remove-sect core',
  'git config --rename-sect core oldcore',
  'chmod -R -x .',
  'chmod --recursive a-x .',
]) {
  test(`[すり抜け] ${command}`, () => assert.notEqual(decision(command), 'allow', command));
}

for (const command of [
  'git config --get core.hooksPath',
  'git config --list',
  'chmod -R -x docs',
  'chmod -x scripts/example.sh',
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}
