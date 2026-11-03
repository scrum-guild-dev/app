import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

type Step = { id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps: Step[] };
const workflow = load(readFileSync(new URL('../.github/workflows/ai-review.yml', import.meta.url), 'utf8')) as {
  jobs: Record<string, Job>;
};
const repository = 'example-org/app';

function event(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    label: { name: 'ai-review' },
    pull_request: {
      draft: false,
      base: { ref: 'main' },
      head: { repo: { full_name: repository } },
      author_association: 'MEMBER',
      user: { login: 'aoba', type: 'User' },
      ...overrides,
    },
  };
}

function condition(expression: string | undefined, payload: ReturnType<typeof event>, allowed: string): boolean {
  assert.ok(expression, '起動条件が無い');
  const source = expression.replace(/^\s*\$\{\{\s*/, '').replace(/\s*\}\}\s*$/, '');
  return Boolean(
    runInNewContext(`(${source})`, {
      github: { repository, event: payload, event_name: 'pull_request' },
      needs: { authorize: { outputs: { allowed } } },
      fromJSON: JSON.parse,
      contains: (values: string[], value: string) =>
        values.some((candidate) => candidate.toLowerCase() === value.toLowerCase()),
    }),
  );
}

describe('ai-review の PR 作成者の実権限による認可', () => {
  test('認可ジョブを先に実行し、その許可が無ければ機密を使うレビューを起動しない', () => {
    const authorize = workflow.jobs.authorize;
    const review = workflow.jobs.review;
    assert.ok(authorize, '権限確認専用の authorize ジョブが無い');
    assert.ok(review);
    const needs = typeof review.needs === 'string' ? [review.needs] : (review.needs ?? []);
    assert.ok(needs.includes('authorize'));
    assert.equal(condition(authorize.if, event(), ''), true, 'MEMBER の作者も権限を確認する');
    assert.equal(condition(review.if, event(), 'true'), true);
    for (const output of ['false', '', 'unknown']) assert.equal(condition(review.if, event(), output), false, output);
  });

  for (const [name, overrides] of [
    ['fork', { head: { repo: { full_name: 'outsider/app' } } }],
    ['draft', { draft: true }],
    ['Bot', { user: { login: 'aoba[bot]', type: 'Bot' } }],
    ['main 以外', { base: { ref: 'release' } }],
  ] as const) {
    test(`${name} は書き込み権限の出力があってもレビューしない`, () => {
      const authorize = workflow.jobs.authorize;
      const review = workflow.jobs.review;
      assert.ok(authorize);
      assert.ok(review);
      assert.equal(
        condition(authorize.if, event(overrides), 'true') && condition(review.if, event(overrides), 'true'),
        false,
      );
    });
  }

  test('無関係なラベルの付与ではレビューせず、ai-review の付与だけを受ける', () => {
    const authorize = workflow.jobs.authorize;
    const review = workflow.jobs.review;
    assert.ok(authorize);
    assert.ok(review);
    const payload = event();
    payload.action = 'labeled';
    payload.label.name = 'area:docs';
    assert.equal(condition(authorize.if, payload, 'true') && condition(review.if, payload, 'true'), false);
    payload.label.name = 'ai-review';
    assert.equal(condition(authorize.if, payload, 'true') && condition(review.if, payload, 'true'), true);
  });

  test('認可前には PR の head コードも機密も使わず、外部入力を run に埋め込まない', () => {
    const job = workflow.jobs.authorize;
    assert.ok(job);
    assert.doesNotMatch(JSON.stringify(job), /secrets\./);
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with?.ref, '${{ github.event.pull_request.base.sha }}');
      }
      assert.doesNotMatch(step.run ?? '', /\$\{\{\s*github\.event\./);
    }
  });

  function checkAuthor(permission: unknown, apiFails = false) {
    const job = workflow.jobs.authorize;
    assert.ok(job, 'authorize ジョブが無い');
    const step = job.steps.find((candidate) => candidate.id === 'permission');
    assert.ok(step?.run, 'API で作成者を確認する permission ステップが無い');
    assert.equal(step.env?.REPO, '${{ github.repository }}');
    assert.equal(step.env?.PR_AUTHOR, '${{ github.event.pull_request.user.login }}');
    assert.equal(job.outputs?.allowed, '${{ steps.permission.outputs.allowed }}');
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-author-permission-'));
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('repos/example-org/app/collaborators/aoba/permission')) process.exit(97);
if (process.env.TEST_API_FAIL === '1') process.exit(1);
const raw = JSON.parse(process.env.TEST_PERMISSION_RESPONSE);
const query = args.indexOf('--jq');
if (query >= 0 && args[query + 1] === '.permission') console.log(raw.permission ?? '');
else console.log(JSON.stringify(raw));
`,
    );
    chmodSync(gh, 0o755);
    const run = spawnSync('bash', ['-c', step.run], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        REPO: repository,
        PR_AUTHOR: 'aoba',
        GITHUB_OUTPUT: output,
        TEST_API_FAIL: apiFails ? '1' : '0',
        TEST_PERMISSION_RESPONSE: JSON.stringify({ permission, user: { login: 'aoba', type: 'User' } }),
      },
    });
    return {
      run,
      values: Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      ),
    };
  }

  for (const permission of ['write', 'maintain', 'admin']) {
    test(`実際の API 応答が ${permission} なら MEMBER の作者を許可する`, () => {
      const { run, values } = checkAuthor(permission);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(values.allowed, 'true');
    });
  }

  for (const permission of ['read', 'triage', 'none', 'owner', '', null, true, { permission: 'admin' }]) {
    test(`API 応答 ${JSON.stringify(permission)} は区分にかかわらず許可しない`, () => {
      const { values } = checkAuthor(permission);
      assert.notEqual(values.allowed, 'true');
    });
  }

  test('API 取得に失敗したら許可を出さない', () => {
    const { values } = checkAuthor('admin', true);
    assert.notEqual(values.allowed, 'true');
  });

  test('コンテキストの CLI には確認済み集合のファイルを必ず渡す', () => {
    const steps = workflow.jobs.review?.steps ?? [];
    const format = steps.find((step) => step.run?.includes('node scripts/ai-review-context.ts'));
    assert.ok(format?.run);
    const command = format.run.split('\n').find((line) => line.includes('node scripts/ai-review-context.ts'));
    assert.ok(command);
    assert.match(
      command,
      /node scripts\/ai-review-context\.ts "\$RAW_DIR" "\$CONTEXT_DIR" "\$RAW_DIR\/write-users\.json"/,
    );
    const resolve = steps.find((step) => step.run?.includes('github-write-permissions.ts'));
    assert.ok(resolve, 'コメントを書いた人の権限を確認する段が無い');
    assert.ok(steps.indexOf(resolve) < steps.indexOf(format));
  });
});
