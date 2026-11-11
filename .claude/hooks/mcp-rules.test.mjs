import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeMcp } from './mcp-rules.mjs';

const decision = (tool, input) => judgeMcp(`mcp__github__${tool}`, input)?.[0] ?? null;
const repo = { owner: 'example-org', repo: 'example' };

describe('judgeMcp', () => {
  test('サーバーの名前に github を含めば、別名、プラグイン、コネクタでも見る', () => {
    for (const name of [
      'mcp__GitHub__push_files',
      'mcp__github-remote__push_files',
      'mcp__plugin_github_github__push_files',
      'mcp__claude_ai_GitHub__push_files',
    ]) {
      assert.equal(judgeMcp(name, { branch: 'production' })?.[0], 'deny', name);
    }
    assert.equal(judgeMcp('mcp__plugin_github_github__merge_pull_request', {})?.[0], 'deny');
    // 名前を知らない書き込み（github_file_ops の commit_files など）は確かめる
    assert.equal(judgeMcp('mcp__github_file_ops__commit_files', { branch: 'claude/x' })?.[0], 'ask');
  });

  test('前置きを何段重ねても外して比べる', () => {
    for (const branch of ['production/', 'refs/heads/main/', 'refs/heads/refs/heads/main', 'heads/refs/heads/production', 'refs/heads/heads/production']) {
      assert.equal(decision('push_files', { branch }), 'deny', branch);
    }
  });

  test('.github/ の下に書くときは、作業ブランチでも確かめる', () => {
    for (const input of [
      { branch: 'claude/x', path: '.github/workflows/x.yml' },
      { branch: 'claude/x', path: './.github/workflows/x.yml' },
      { branch: 'claude/x', path: '/.GitHub/workflows/x.yml' },
      { branch: 'claude/x', path: 'docs/../.github/workflows/x.yml' },
      { branch: 'claude/x', files: [{ path: 'README.md' }, { path: '.github/workflows/x.yml' }] },
      { branch: 'claude/x', files: [{ path: 42 }] },
    ]) {
      assert.equal(decision('push_files', input), 'ask', JSON.stringify(input));
      assert.equal(decision('create_or_update_file', input), 'ask', JSON.stringify(input));
    }
    assert.equal(decision('push_files', { branch: 'claude/x', files: [{ path: 'docs/github/x.md' }, { path: 'x.github/y' }] }), null);
    assert.equal(decision('delete_file', { branch: 'claude/x', path: '.github/workflows/x.yml' }), 'ask');
    assert.equal(decision('create_branch', { branch: 'claude/x', from_branch: 'main' }), null);
  });

  test('サーバーの名前に __ があっても、最後の __ でツールの名前を読む', () => {
    assert.equal(judgeMcp('mcp__my__github__push_files', { branch: 'production' })?.[0], 'deny');
    assert.equal(judgeMcp('mcp__my__github__merge_pull_request', {})?.[0], 'deny');
  });

  test('.github/ の宛先を読めない形も確かめる', () => {
    for (const input of [
      { branch: 'claude/x', files: { path: '.github/workflows/x.yml' } },
      { branch: 'claude/x', files: ['.github/workflows/x.yml'] },
      { branch: 'claude/x', path: '.%67ithub/workflows/x.yml' },
    ]) {
      assert.equal(decision('push_files', input), 'ask', JSON.stringify(input));
    }
  });

  test('GitHub のサーバーでないツールは見ない', () => {
    assert.equal(judgeMcp('mcp__other__push_files', { branch: 'production' }), null);
    assert.equal(judgeMcp('mcp__Claude_Docs__update', { branch: 'production' }), null);
    assert.equal(judgeMcp('Bash', { command: 'ls' }), null);
    assert.equal(judgeMcp(undefined, {}), null);
  });

  test('読むだけのツールは判定しない', () => {
    for (const tool of [
      'get_me',
      'get_file_contents',
      'get_latest_release',
      'get_tag',
      'list_branches',
      'list_releases',
      'list_tags',
      'search_issues',
      'issue_read',
      'pull_request_read',
      'actions_get',
      'actions_list',
    ]) {
      assert.equal(decision(tool, { ...repo, branch: 'production' }), null, tool);
    }
  });

  for (const tool of ['push_files', 'create_or_update_file', 'delete_file', 'create_branch']) {
    describe(tool, () => {
      test('production、main、タグには書かせない（大文字小文字は区別しない）', () => {
        for (const branch of [
          'production',
          'refs/heads/production',
          'heads/production',
          ' production ',
          'Production',
          'REFS/HEADS/PRODUCTION',
          'main',
          'refs/heads/main',
          'Main',
          'tags/v0.1.0',
          'refs/tags/v0.1.0',
          'refs/tags/other',
          '/main',
          '//production',
          '/refs/heads/main',
          '/tags/v1',
          'heads//production',
          'refs/heads//main',
          'refs//heads//main',
        ]) {
          assert.equal(decision(tool, { ...repo, branch }), 'deny', branch);
        }
      });

      test('作業ブランチには書かせる', () => {
        for (const branch of ['claude/keen-ride-3lgflr', '1165-release-version', 'production-docs', 'mainline', 'v2-redesign', 'refs/heads/v0.1.0', 'version']) {
          assert.equal(decision(tool, { ...repo, branch }), null, branch);
        }
      });

      test('ブランチの名前を字面で読めなければ確かめる', () => {
        for (const branch of [undefined, null, 42, '', 'produc%74ion', 'refs/heads/./production', 'a/../production', 'pro\nduction', 'pro\tduction', 'pro\u007fduction', 'x\\y', '/', 'refs/heads/']) {
          assert.equal(decision(tool, { ...repo, branch }), 'ask', String(branch));
        }
      });
    });
  }

  test('base が production の PR は作らせず、base を production に付け替えさせない', () => {
    assert.equal(decision('create_pull_request', { ...repo, base: 'production', head: 'x' }), 'deny');
    assert.equal(decision('create_pull_request', { ...repo, base: 'refs/heads/production', head: 'x' }), 'deny');
    assert.equal(decision('create_pull_request', { ...repo, base: 'Production', head: 'x' }), 'deny');
    assert.equal(decision('update_pull_request', { ...repo, pullNumber: 1, base: 'production' }), 'deny');
    for (const base of ['tags/v1', 'refs/tags/v1']) {
      assert.equal(decision('create_pull_request', { ...repo, base, head: 'x' }), 'deny', base);
      assert.equal(decision('update_pull_request', { ...repo, pullNumber: 1, base }), 'deny', base);
    }
  });

  test('base が文字列でなければ確かめる', () => {
    for (const base of [0, false, 42, ['production']]) {
      assert.equal(decision('update_pull_request', { ...repo, pullNumber: 1, base }), 'ask', String(base));
    }
  });

  test('base が main か作業ブランチの PR はふだんの作業なので通す', () => {
    assert.equal(decision('create_pull_request', { ...repo, base: 'main', head: 'x' }), null);
    assert.equal(decision('create_pull_request', { ...repo, base: 'refs/heads/main', head: 'x' }), null);
    assert.equal(decision('update_pull_request', { ...repo, pullNumber: 1, base: 'main' }), null);
    assert.equal(decision('create_pull_request', { ...repo, base: '1165-release-version', head: 'x' }), null);
  });

  test('base を付け替えない PR の更新は通し、作る PR の base が無ければ確かめる', () => {
    for (const base of [undefined, null, '']) {
      assert.equal(decision('update_pull_request', { ...repo, pullNumber: 1, title: 't', base }), null, String(base));
    }
    assert.equal(decision('create_pull_request', { ...repo, head: 'x' }), 'ask');
    assert.equal(decision('create_pull_request', { ...repo, head: 'x', base: '' }), 'ask');
  });

  test('MCP からはマージさせない（base を問わない）', () => {
    assert.equal(decision('merge_pull_request', { ...repo, pullNumber: 1, merge_method: 'squash' }), 'deny');
    assert.equal(decision('enable_pr_auto_merge', { ...repo, pullNumber: 1 }), 'deny');
  });

  test('Release とタグを書き換えるツールは、足されても止める', () => {
    for (const tool of ['create_release', 'update_release', 'delete_release', 'publish_release', 'create_tag', 'delete_tags']) {
      assert.equal(decision(tool, repo), 'deny', tool);
    }
  });

  test('release と tag を語の一部に持つだけのツールは止めない（判定を知らない書き込みとして確かめる）', () => {
    for (const tool of ['stage_files', 'vantage_point', 'retag']) {
      assert.equal(decision(tool, repo), 'ask', tool);
    }
  });

  test('Object の既定のキーと同じ名前のツールも、判定を知らない書き込みとして確かめる', () => {
    for (const tool of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(decision(tool, { branch: 'production' }), 'ask', tool);
    }
  });

  test('守る ref に触れない書き込みは通す', () => {
    for (const tool of [
      'add_issue_comment',
      'add_reply_to_pull_request_comment',
      'issue_write',
      'sub_issue_write',
      'pull_request_review_write',
      'resolve_review_thread',
      'add_comment_to_pending_review',
      'unresolve_review_thread',
      'request_copilot_review',
      'update_issue_comment',
      'run_secret_scanning',
      'issue_dependency_write',
      'disable_pr_auto_merge',
    ]) {
      assert.equal(decision(tool, repo), null, tool);
    }
  });

  test('CI の AI レビューのインラインの指摘のツールは通す', () => {
    assert.equal(judgeMcp('mcp__github_inline_comment__create_inline_comment', { path: 'a', line: 1, body: 'x' }), null);
  });

  // update_pull_request_branch は base を head に取り込む。head を MCP の入力で見られないので確かめる（sync-base は git で行う）
  test('判定を知らない書き込みは確かめる', () => {
    for (const tool of ['update_pull_request_branch', 'fork_repository', 'create_repository', 'actions_run_trigger', 'something_new']) {
      assert.equal(decision(tool, repo), 'ask', tool);
    }
  });
});

describe('guard-mcp.mjs', () => {
  const hooks = path.dirname(fileURLToPath(import.meta.url));
  const run = (file, stdin) => spawnSync(process.execPath, [file], { input: stdin, encoding: 'utf8' });
  const input = (tool_name, tool_input) => JSON.stringify({ tool_name, tool_input });

  test('止めるものは deny を返し、通すものは何も出さない', () => {
    const denied = run(path.join(hooks, 'guard-mcp.mjs'), input('mcp__github__push_files', { ...repo, branch: 'production' }));
    assert.equal(denied.status, 0, denied.stderr);
    const output = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /production/);
    const allowed = run(path.join(hooks, 'guard-mcp.mjs'), input('mcp__github__push_files', { ...repo, branch: 'claude/x' }));
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout, '');
    const asked = run(path.join(hooks, 'guard-mcp.mjs'), input('mcp__github__update_pull_request_branch', { ...repo, pullNumber: 1 }));
    assert.equal(asked.status, 0, asked.stderr);
    assert.equal(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });

  test('入力が壊れていたか、判定のモジュールを読めなければ exit 2 で止める', () => {
    assert.equal(run(path.join(hooks, 'guard-mcp.mjs'), '{bad').status, 2);
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-mcp-'));
    try {
      copyFileSync(path.join(hooks, 'guard-mcp.mjs'), path.join(dir, 'guard-mcp.mjs'));
      assert.equal(run(path.join(dir, 'guard-mcp.mjs'), input('mcp__github__get_me', {})).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('settings.json が GitHub の MCP のツールにこのフックを掛けている', () => {
    const settings = JSON.parse(readFileSync(path.join(hooks, '..', 'settings.json'), 'utf8'));
    const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes('guard-mcp.mjs')));
    assert.ok(entry, 'guard-mcp.mjs の PreToolUse が無い');
    for (const name of ['mcp__github__push_files', 'mcp__plugin_github_github__push_files', 'mcp__claude_ai_GitHub__merge_pull_request', 'mcp__my__github__push_files']) {
      assert.ok(new RegExp(`^(${entry.matcher})$`).test(name), name);
    }
    // GitHub でない MCP には掛けない（フックが落ちたときに、ほかの MCP まで止めない）
    for (const name of ['mcp__Claude_Docs__update', 'mcp__Slack__slack_send_message']) {
      assert.ok(!new RegExp(`^(${entry.matcher})$`).test(name), name);
    }
    assert.equal(entry.hooks.find((h) => h.command.includes('guard-mcp.mjs')).onFailure, 'block');
  });
});
