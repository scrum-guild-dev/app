import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { reconcile, ISSUE_MARKER, type Api, type Run } from './main-health.ts';

const run: Run = {
  id: 10,
  run_attempt: 1,
  head_sha: 'abc',
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/example/app/actions/runs/10',
};
function fixture() {
  const state = {
    runs: [{ ...run }],
    sha: 'abc',
    issues: [] as { number: number; body: string; user: { login: string }; pull_request?: unknown }[],
    comments: [] as { body: string; user: { login: string } }[],
    writes: [] as { path: string; method: string; body: Record<string, unknown> }[],
  };
  const api: Api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (method !== 'GET') {
      state.writes.push({ path, method, body: body as Record<string, unknown> });
      if (path === '/issues')
        state.issues.push({ number: 1, body: (body as { body: string }).body, user: { login: 'github-actions[bot]' } });
      if (path.endsWith('/comments'))
        state.comments.push({ body: (body as { body: string }).body, user: { login: 'github-actions[bot]' } });
      return {} as T;
    }
    if (path.startsWith('/actions/workflows/')) return { workflow_runs: state.runs } as T;
    if (path === '/commits/main') return { sha: state.sha } as T;
    if (path.startsWith('/actions/runs/'))
      return {
        jobs: [
          { name: 'e2e (1)', conclusion: 'failure', html_url: 'https://github.com/example/app/actions/runs/10/job/1' },
        ],
      } as T;
    if (path.endsWith('/comments?direction=asc&per_page=100&page=1')) return state.comments as T;
    if (path.startsWith('/issues?')) return state.issues as T;
    if (path.startsWith('/labels?')) return [{ name: 'main-broken' }] as T;
    throw new Error(`Unexpected API: ${path}`);
  };
  return { state, api };
}

test('失敗で最優先の Issue を作り、ログ・SHA・指定した通知先を含める。繰り返しの監視は重複しない', async () => {
  const { state, api } = fixture();
  await reconcile(api, 'aoba,kaede');
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].body.labels, ['main-broken']);
  assert.match(state.issues[0].body, /@aoba @kaede/);
  assert.match(state.issues[0].body, /e2e \(1\)/);
  assert.match(state.issues[0].body, /コミット: abc/);
  await reconcile(api);
  assert.equal(state.writes.length, 1);
});

test('次の失敗と再実行の失敗は既存 Issue に各1回追記する', async () => {
  const { state, api } = fixture();
  await reconcile(api);
  state.runs[0].id++;
  await reconcile(api);
  await reconcile(api);
  assert.equal(state.comments.length, 1);
  state.runs[0].run_attempt++;
  await reconcile(api);
  assert.equal(state.comments.length, 2);
  assert.equal(state.writes.filter((write) => write.path === '/issues').length, 1);
});

test('最新 main の成功だけで復旧コメントとクローズを行う', async () => {
  const { state, api } = fixture();
  await reconcile(api);
  state.runs[0] = { ...run, id: 11, conclusion: 'success' };
  await reconcile(api);
  assert.match(state.comments[0].body, /最新の main の CI が成功/);
  assert.deepEqual(state.writes.at(-1)?.body, { state: 'closed', state_reason: 'completed' });
});

for (const scenario of ['古い SHA', '実行中', '未実行', 'PR']) {
  test(`${scenario} では Issue を作成・クローズしない`, async () => {
    const { state, api } = fixture();
    if (scenario === '古い SHA') state.sha = 'def';
    if (scenario === '実行中') state.runs[0].status = 'in_progress';
    if (scenario === '未実行') state.runs = [];
    if (scenario === 'PR') state.runs[0].event = 'pull_request';
    await reconcile(api);
    assert.equal(state.writes.length, 0);
  });
}

test('成功の二重確認中に push があれば閉じない', async () => {
  const { state, api } = fixture();
  await reconcile(api);
  state.runs[0] = { ...run, id: 11, conclusion: 'success' };
  let reads = 0;
  const racingApi: Api = async <T>(path: string, method?: string, body?: unknown) => {
    if (path === '/commits/main' && ++reads === 2) state.sha = 'new';
    return api<T>(path, method, body);
  };
  await reconcile(racingApi);
  assert.equal(state.writes.length, 1);
});

test('キャンセルを成功とみなさず通知する', async () => {
  const { state, api } = fixture();
  state.runs[0].conclusion = 'cancelled';
  await reconcile(api);
  assert.match(state.issues[0].body, /cancelled/);
});

test('人の本文に同じ印があっても変更しない', async () => {
  const { state, api } = fixture();
  state.issues.push({ number: 50, body: ISSUE_MARKER, user: { login: 'aoba' } });
  await reconcile(api);
  assert.equal(state.writes[0].path, '/issues');
});

test('PR の実行名は label.yml が完全一致で参照する既存形式を維持する', () => {
  const ci = load(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(
    ci['run-name'],
    'ci pr=${{ github.event.pull_request.number }} base=${{ github.event.pull_request.base.ref }}',
  );
});

test('main の CI と通知の起動条件・権限を保つ', () => {
  const read = (name: string) =>
    load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as Record<string, unknown>;
  const ci = read('ci') as {
    on: Record<string, unknown>;
    jobs: { changes: { outputs: Record<string, string>; steps: { id?: string; if?: string; run?: string }[] } };
    permissions: unknown;
  };
  assert.deepEqual(ci.on.push, { branches: ['main'] });
  assert.ok(ci.on.schedule);
  const main = ci.jobs.changes.steps.find((step) => step.id === 'main');
  assert.equal(main?.if, "github.event_name != 'pull_request'");
  for (const output of ['docs_only=false', 'dev_build=true', 'repeat=false']) assert.ok(main?.run?.includes(output));
  for (const id of ['docs', 'repeat'])
    assert.equal(ci.jobs.changes.steps.find((step) => step.id === id)?.if, "github.event_name == 'pull_request'");
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const monitor = read('main-health') as { on: Record<string, unknown>; permissions: unknown };
  assert.deepEqual(monitor.on.workflow_run, { workflows: ['ci'], branches: ['main'], types: ['completed'] });
  assert.deepEqual(monitor.permissions, { contents: 'read', actions: 'read', issues: 'write' });
});

for (const scenario of ['未実行', '実行中', '古い SHA']) {
  test(`${scenario} で待機する理由をログに出す`, async () => {
    const { state, api } = fixture();
    if (scenario === '未実行') state.runs = [];
    if (scenario === '実行中') state.runs[0].status = 'in_progress';
    if (scenario === '古い SHA') state.sha = 'new';
    const logs: string[] = [];
    await reconcile(api, '', (message) => logs.push(message));
    assert.equal(state.writes.length, 0);
    assert.ok(logs.some((message) => message.includes(scenario)));
  });
}
