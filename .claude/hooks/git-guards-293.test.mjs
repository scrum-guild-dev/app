// #293: git の別名、前置き、設定と守るファイルの変更の回帰テスト。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const context = (branch = 'main', extra = {}) => ({ cwd: '/repo', branchOf: () => branch, ...extra });
const decision = (command, options = context()) => judgeBash(command, options)?.[0] ?? 'allow';

// 個々の拒否理由は既存の強い deny を維持できるよう固定せず、素通りしないことを確かめる。
const guarded = {
  '別名と未知のサブコマンド': [
    "git -c alias.ci='commit --no-verify' ci -m y",
    "git config alias.ci 'commit --no-verify'",
    'git ci -m y',
    "git -c alias.c='clean -fdx' c",
  ],
  '値を取るグローバルオプション': [
    'git --config-env core.hooksPath=HOME commit -m y',
    'git --attr-source HEAD commit -m y',
    'git --config-env=core.hooksPath=HOME status',
  ],
  'git を動かす前置きと本文': [
    'setsid git commit --no-verify -m y',
    'find . -maxdepth 0 -exec git commit --no-verify -m y \\;',
    'flock /tmp/293.lock git commit -m y',
    'taskset -c 0 git commit -m y',
    `perl -e 'system("git push origin main")'`,
    `python3 -c 'import os; os.system("git commit -m y")'`,
    `python3 -c'import os; os.system("git commit -m y")'`,
    `python3 <<'PY'\nimport os\nos.system("git commit -m y")\nPY`,
    'sudo -E git commit -m y',
    'command -p git commit -m y',
    'time -p git commit -m y',
    'exec -a git-wrapper git commit -m y',
    'stdbuf -o L git commit -m y',
    "bash -c -- 'git commit -m y'",
  ],
  '設定の操作': [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git status',
    'GIT_CONFIG_KEY_0=core.hooksPath git status',
    'GIT_CONFIG_VALUE_0=/tmp git status',
    `GIT_CONFIG_PARAMETERS="'core.hooksPath=/tmp'" git status`,
    'export GIT_CONFIG_COUNT=1; git status',
    'git config --remove-section core',
    'git config --rename-section core oldcore',
    'git config remove-section core',
    'git config rename-section core oldcore',
    'echo x >> .git/config',
  ],
  'push の暗黙の先と低水準の操作': [
    'git -c remote.origin.push=HEAD:refs/heads/main push origin',
    'git -c push.default=matching push origin',
    'git send-pack origin HEAD:refs/heads/main',
  ],
  '守るファイルの変更と権限の変更': [
    'chmod -x .githooks/pre-commit',
    'chmod 644 .githooks/pre-push',
    'find .githooks -delete',
    'git rm .githooks/pre-commit',
    'git mv .githooks/pre-commit old-hook',
    'git checkout -- .claude/hooks/bash-rules.mjs',
    'git checkout HEAD -- .claude/settings.json',
    'git restore .claude/hooks/bash-rules.mjs',
    'git restore --source HEAD -- .githooks/pre-push',
  ],
  'glob のコピーと削除': [
    'cp -r /tmp/evil/migr* .',
    'rm .claude/h*/*.mjs',
    'rm -rf *',
    'rm -rf ../*',
    'rm -rf ~/*',
    'rm -rf /*',
    'cd src/deep; rm -rf ../../*',
  ],
  'zsh の数値の glob': [
    '<1-1> git commit -m y',
    '<1-1> git push origin main',
  ],
};

describe('#293: main と守る先を素通りさせない', () => {
  for (const [kind, commands] of Object.entries(guarded)) {
    for (const command of commands) {
      test(`[すり抜け: ${kind}] ${command}`, () => {
        assert.notEqual(decision(command), 'allow', command);
      });
    }
  }
});

describe('#293: 読み取りと作業ブランチの通常操作は通す', () => {
  for (const command of [
    'git status',
    'git log --oneline',
    'git diff -- .claude/hooks/bash-rules.mjs',
    'git config --get alias.ci',
    'git config --get core.hooksPath',
    'git config --list',
    'echo git commit --no-verify -m y',
    'rg "git push origin main" docs',
    `python3 -c 'print(1)'`,
    'chmod +x scripts/example.sh',
    'git rm docs/example.md',
    'git mv docs/old.md docs/new.md',
    'git checkout -- docs/example.md',
    'git restore docs/example.md',
    'cp -r /tmp/evil/images .',
    'git commit -m y',
    'git push origin 293-hook-guards',
  ]) {
    test(`[通す] ${command}`, () => assert.equal(decision(command, context('293-hook-guards')), 'allow', command));
  }
});

describe('#293: セッションの git の作業場所を無視しない', () => {
  for (const env of [{ GIT_DIR: '/other/.git' }, { GIT_WORK_TREE: '/other' }]) {
    test(JSON.stringify(env), () => {
      // 起動元のブランチが作業ブランチでも、環境変数の先は main かもしれない。
      assert.notEqual(decision('git commit -m y', context('293-hook-guards', { env })), 'allow');
    });
  }
});
