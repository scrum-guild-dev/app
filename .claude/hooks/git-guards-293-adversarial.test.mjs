// #293: 崩す役が追加した、元の71件と異なる pathspec の回帰。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = { cwd: '/repo', branchOf: () => 'main' };
const decision = (command) => judgeBash(command, context)?.[0] ?? 'allow';

describe('#293: git の pathspec が守るファイルを含みうる形も確認する', () => {
  for (const command of [
    'git restore .',
    'git checkout HEAD -- .',
    'git rm -r .',
    'git restore --source HEAD -- :/',
    'git restore --source HEAD -- ":(top).claude/hooks/bash-rules.mjs"',
    'git restore --pathspec-from-file=list',
    'git checkout HEAD --pathspec-from-file=list',
  ]) {
    test(command, () => assert.notEqual(decision(command), 'allow'));
  }
});

describe('#293: pathspec 判定で通常ファイルの操作と読み取りを止めない', () => {
  for (const command of ['git restore docs/readme.md', 'git checkout HEAD -- src/example.ts', 'git diff -- .', 'git config --get core.hooksPath']) {
    test(command, () => assert.equal(decision(command), 'allow'));
  }
});
