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
  test('GitHub のサーバーでないツールは見ない', () => {
    assert.equal(judgeMcp('mcp__other__push_files', { branch: 'production' }), null);
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
      test('production、main、v* のタグには書かせない', () => {
        for (const branch of [
          'production',
          'refs/heads/production',
          'heads/production',
          ' production ',
          'main',
          'refs/heads/main',
          'v0.1.0',
          'v1',
          'tags/v0.1.0',
          'refs/tags/v0.1.0',
          'refs/tags/other',
        ]) {
          assert.equal(decision(tool, { ...repo, branch }), 'deny', branch);
        }
      });

      test('作業ブランチには書かせる', () => {
        for (const branch of ['claude/keen-ride-3lgflr', '1165-release-version', 'production-docs', 'mainline', 'refs/heads/v0.1.0', 'version']) {
          assert.equal(decision(tool, { ...repo, branch }), null, branch);
        }
      });

      test('ブランチの名前を字面で読めなければ確かめる', () => {
        for (const branch of [undefined, null, 42, '', 'produc%74ion', 'refs/heads/./production', 'heads//production', 'a/../production', 'pro\nduction', 'x\\y']) {
          assert.equal(decision(tool, { ...repo, branch }), 'ask', String(branch));
        }
      });
    });
  }

  test('base が production か main の PR は作らせず、base を production に付け替えさせない', () => {
    assert.equal(decision('create_pull_request', { ...repo, base: 'production', head: 'x' }), 'deny');
    assert.equal(decision('create_pull_request', { ...repo, base: 'refs/heads/production', head: 'x' }), 'deny');
    assert.equal(decision('update_pull_request', { ...repo, pullNumber: 1, base: 'production' }), 'deny');
    assert.equal(decision('create_pull_request', { ...repo, base: 'main', head: 'x' }), 'deny');
  });

  test('base を指さない PR の更新と、作業ブランチを base にする PR は通す', () => {
    assert.equal(decision('update_pull_request', { ...repo, pullNumber: 1, title: 't' }), null);
    assert.equal(decision('create_pull_request', { ...repo, base: '1165-release-version', head: 'x' }), null);
    assert.equal(decision('create_pull_request', { ...repo, head: 'x' }), 'ask');
  });

  test('MCP からはマージさせない（base を問わない）', () => {
    assert.equal(decision('merge_pull_request', { ...repo, pullNumber: 1, merge_method: 'squash' }), 'deny');
    assert.equal(decision('enable_pr_auto_merge', { ...repo, pullNumber: 1 }), 'deny');
  });

  test('Release とタグを書き換えるツールは、足されても止める', () => {
    for (const tool of ['create_release', 'update_release', 'delete_release', 'publish_release', 'create_tag']) {
      assert.equal(decision(tool, repo), 'deny', tool);
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
      'update_issue_comment',
      'disable_pr_auto_merge',
    ]) {
      assert.equal(decision(tool, repo), null, tool);
    }
  });

  test('判定を知らない書き込みは確かめる', () => {
    for (const tool of ['update_pull_request_branch', 'fork_repository', 'create_repository', 'actions_run_trigger', 'something_new']) {
      assert.equal(decision(tool, repo), 'ask', tool);
    }
  });
});

describe('guard-mcp.mjs', () => {
  const hooks = path.dirname(fileURLToPath(import.meta.url));
  const run = (file, stdin) => spawnSync(process.execPath, [file], { input: stdin, encoding: 'utf8' });
  const input = (tool_name, tool_input) => JSON.stringify({ tool_name, tool_input, cwd: hooks });

  test('止めるものは deny を返し、通すものは何も出さない', () => {
    const denied = run(path.join(hooks, 'guard-mcp.mjs'), input('mcp__github__push_files', { ...repo, branch: 'production' }));
    assert.equal(denied.status, 0, denied.stderr);
    const output = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /production/);
    const allowed = run(path.join(hooks, 'guard-mcp.mjs'), input('mcp__github__push_files', { ...repo, branch: 'claude/x' }));
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout, '');
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
    assert.ok(new RegExp(`^(${entry.matcher})$`).test('mcp__github__push_files'));
    assert.equal(entry.hooks.find((h) => h.command.includes('guard-mcp.mjs')).onFailure, 'block');
  });
});
