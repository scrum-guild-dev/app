// main の CI を GitHub Issue で追う。依存パッケージを導入せずに動かす。
export const ISSUE_MARKER = '<!-- main-health:v1 -->';
export const LABEL = 'main-broken';
export type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};
type Issue = { number: number; body: string | null; user: { login: string }; pull_request?: unknown };
export type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export async function reconcile(api: Api, notify = '', log: (message: string) => void = console.log): Promise<void> {
  const latest = async () => {
    const { workflow_runs: runs } = await api<{ workflow_runs: Run[] }>(
      '/actions/workflows/ci.yml/runs?branch=main&per_page=100',
    );
    return runs.find(
      (run) => run.head_branch === 'main' && ['push', 'schedule', 'workflow_dispatch'].includes(run.event),
    );
  };
  const run = await latest();
  if (!run) {
    log('main の CI は未実行です。Actions の起動条件・有効状態を確認してください。');
    return;
  }
  if (run.status !== 'completed') {
    log(`main の CI は実行中または待機中です（run=${run.id}、status=${run.status}）。完了を待ちます。`);
    return;
  }

  const head = await api<{ sha: string }>('/commits/main');
  // 新しい main の検査を待つ。古い成功で閉じたり、古い失敗を新しい障害として通知しない。
  if (run.head_sha !== head.sha) {
    log(
      `古い SHA の CI です（run=${run.id}、CI=${run.head_sha}、main=${head.sha}）。最新 main の CI を手動実行するか、起動条件を確認してください。`,
    );
    return;
  }

  async function pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const items = await api<T[]>(`${path}&per_page=100&page=${page}`);
      all.push(...items);
      if (items.length < 100) return all;
    }
  }
  const issues = (await pages<Issue>('/issues?state=open&labels=main-broken')).filter(
    (issue) => !issue.pull_request && issue.user.login === 'github-actions[bot]' && issue.body?.includes(ISSUE_MARKER),
  );
  const marker = `<!-- main-health:run=${run.id}:attempt=${run.run_attempt} -->`;
  const mentions = notify
    .split(/[\s,]+/)
    .filter((login) => /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login))
    .map((login) => `@${login}`)
    .join(' ');
  const summary = `${marker}\n${mentions}\nコミット: ${run.head_sha}\nCI: ${run.html_url}（試行 ${run.run_attempt}、${run.conclusion}）`;
  const commentOnce = async (issue: Issue, body: string) => {
    if (issue.body?.includes(marker)) return;
    const comments = await pages<{ body: string; user: { login: string } }>(
      `/issues/${issue.number}/comments?direction=asc`,
    );
    if (comments.some((comment) => comment.user.login === 'github-actions[bot]' && comment.body.includes(marker)))
      return;
    await api(`/issues/${issue.number}/comments`, 'POST', { body });
  };

  if (run.conclusion === 'success') {
    if (!issues.length) {
      log('最新 main の CI は成功済みで、開いている復旧 Issue はありません。');
      return;
    }
    // API の読み取り中に push や再実行があれば、次の監視に任せる。
    const current = await latest();
    const currentHead = await api<{ sha: string }>('/commits/main');
    if (
      current?.id !== run.id ||
      current.run_attempt !== run.run_attempt ||
      current.status !== 'completed' ||
      current.conclusion !== 'success' ||
      currentHead.sha !== run.head_sha
    ) {
      log('再確認中に main または CI の結果が変わりました。次の監視で確認します。');
      return;
    }
    for (const issue of issues) {
      await commentOnce(issue, `最新の main の CI が成功しました。通常の作業を再開できます。\n\n${summary}`);
      await api(`/issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    }
    return;
  }

  // 失敗だけでなくキャンセル・タイムアウト等も、正常を確認できない状態として追う。
  const jobs: { name: string; conclusion: string | null; html_url: string }[] = [];
  for (let page = 1; ; page++) {
    const result = await api<{ jobs: typeof jobs }>(
      `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  const failed = jobs.filter((job) => !['success', 'skipped'].includes(job.conclusion ?? ''));
  const body = `main の正常を確認できません。復旧を最優先にしてください。\n\n${summary}\n\n${failed.map((job) => `- [${job.name.replace(/[[\]<>]/g, '')}](${job.html_url}): ${job.conclusion ?? '未完了'}`).join('\n')}\n\n復旧手順: docs/development.md の「main の障害通知と復旧」を参照。`;
  if (issues.length) {
    await commentOnce(issues[0], body);
  } else {
    // ラベルが無ければ作る。既存ラベルの変更はしない。
    const labels = await pages<{ name: string }>('/labels?');
    if (!labels.some((label) => label.name === LABEL))
      await api('/labels', 'POST', { name: LABEL, color: 'b60205', description: '最優先: main の CI を復旧する' });
    await api('/issues', 'POST', {
      title: '[main障害] CI を復旧する（最優先）',
      labels: [LABEL],
      body: `${ISSUE_MARKER}\n${body}`,
    });
  }
}

if (import.meta.main) {
  const repo = process.env.REPO;
  const token = process.env.GH_TOKEN;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error('REPO と GH_TOKEN が必要です');
  const api: Api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path}: ${response.status}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  await reconcile(api, process.env.MAIN_CI_NOTIFY);
}
