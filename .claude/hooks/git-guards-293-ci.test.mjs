// #293: CI レビュー後の前置き・シェル本文・設定継承の回帰。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const repo = mkdtempSync(path.join(os.tmpdir(), '293-ci-'));
mkdirSync(path.join(repo, 'scripts'));
mkdirSync(path.join(repo, 'src/deep'), { recursive: true });
writeFileSync(path.join(repo, 'scripts/deploy-production.ts'), '// root marker\n');
writeFileSync(path.join(repo, 'package.json'), '{}\n');
after(() => rmSync(repo, { recursive: true, force: true }));
const context = { cwd: repo, branchOf: () => '293-hook-guards' };
const decision = (command, extra = {}) => judgeBash(command, { ...context, ...extra })?.[0] ?? 'allow';

// ここにある git の書き込みは実行せず、フックの判定だけを呼ぶ。
for (const command of [
  `bash -c -e 'git push --no-verify origin HEAD:main'`,
  `sh -c -e 'git push --no-verify origin HEAD:main'`,
  `bash -c -o pipefail 'git push --no-verify origin HEAD:main'`,
  `bash -c +x 'git push --no-verify origin HEAD:main'`,
  `setsid sh -c 'git push --no-verify origin HEAD:main'`,
  `flock /tmp/293.lock python3 -c 'import os; os.system("git commit -m y")'`,
  `taskset -c 0 sh -c 'git push --no-verify origin HEAD:main'`,
  `setsid "$(command -v git)" commit -m y`,
  'pnpm exec env GIT_CONFIG_GLOBAL=/tmp/x git commit -m y',
  'find . -maxdepth 0 -exec env GIT_CONFIG_GLOBAL=/tmp/x git commit -m y \\;',
  'sudo -n git commit --no-verify -m y',
  'sudo -s git commit --no-verify -m y',
  `eval 'export GIT_CONFIG_GLOBAL=/tmp/x'; git status`,
  'source /tmp/setup.sh; git status',
  '. /tmp/setup.sh; git status',
  'export "$K=$V"; git status',
]) {
  test(`[すり抜け] ${command}`, () => assert.notEqual(decision(command), 'allow', command));
}

// 実在する根を引き当て、削除の祖先ループを通る。名前だけの仮想 cwd では検証できない。
for (const [command, cwd] of [
  ['rm -rf ../*', repo],
  ['rm -rf ../../*', path.join(repo, 'src/deep')],
  [`rm -rf ${path.join(path.dirname(repo), '293-ci-*')}`, repo],
]) {
  test(`[祖先 glob] ${command}`, () => assert.equal(decision(command, { cwd }), 'ask', command));
}

for (const command of [
  `bash -c 'printf ok'`,
  `bash -c -e 'printf ok'`,
  `bash -c -o pipefail 'printf ok'`,
  `bash -c +x 'printf ok'`,
  'pnpm exec env NODE_ENV=development git status',
  'git status',
  'rm -rf build/*',
]) {
  test(`[通す] ${command}`, () => assert.equal(decision(command), 'allow', command));
}
