import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

// .github/workflows/release-drafter.yml と .github/release-drafter.yml の決まりを確かめる（docs/development.md の「リリース」）。

type Step = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, string> };
type Job = { if: string; permissions: Record<string, string>; steps: Step[]; concurrency?: unknown };

const workflow = load(readFileSync(new URL('../.github/workflows/release-drafter.yml', import.meta.url), 'utf8')) as {
  on: { push: { branches: string[] }; pull_request_target: { types: string[] } };
  permissions?: unknown;
  jobs: { draft: Job; autolabel: Job };
};

const config = load(readFileSync(new URL('../.github/release-drafter.yml', import.meta.url), 'utf8')) as {
  'name-template': string;
  'tag-template': string;
  'sync-labels': boolean;
  categories: {
    title?: string;
    type?: string;
    'semver-increment'?: string;
    exclusive?: boolean;
    when?: { label: string };
  }[];
  autolabeler: { labels: string[]; title: string[] }[];
};

// release-drafter の autolabeler と同じ読み方で、/…/flags の文字列を正規表現にする（packages/autolabeler/src/util.ts）
function toRegex(literal: string): RegExp {
  assert.match(literal, /^\/.+\/[gimsuy]*$/, `正規表現の形でない: ${literal}`);
  const delimiter = literal.lastIndexOf('/');
  return new RegExp(literal.slice(1, delimiter), literal.slice(delimiter + 1));
}

function labelsFor(title: string): string[] {
  return config.autolabeler.filter((rule) => rule.title.some((r) => toRegex(r).test(title))).flatMap((r) => r.labels);
}

function expression(value: string): string {
  const match = /^\$\{\{\s*([\s\S]+?)\s*\}\}$/.exec(value);
  assert.ok(match, `式の形でない: ${value}`);
  return match[1];
}

function runs(job: Job, eventName: string): boolean {
  return Boolean(runInNewContext(`(${job.if})`, { github: { event_name: eventName } }));
}

describe('PR のタイトルの種別のラベル', () => {
  const cases: [string, string[]][] = [
    ['feat: 自分の設定でテーマを選べる (#674)', ['release:feat']],
    ['feat(me): 自分の設定でテーマを選べる (#674)', ['release:feat']],
    ['feat!: 非互換の変更 (#1)', ['release:feat']],
    ['feat(api)!: 非互換の変更 (#1)', ['release:feat']],
    ['fix: 直す (#2)', ['release:fix']],
    ['fix(auth): 古い盗難 Cookie を拒む (#1144)', ['release:fix']],
    ['docs: fix の書き方を直す', []],
    ['refactor: feat: を含む', []],
    ['feature: 種別でない', []],
    ['fixup: 種別でない', []],
    ['Feat: 大文字は種別と読まない', []],
    ['ci: マージで次の版と下書きの Release が用意される (#1162)', []],
    ['test(e2e): 待ちを足す', []],
    [' feat: 先頭の空白', []],
  ];
  for (const [title, expected] of cases) {
    test(`「${title}」には ${expected.join(', ') || 'ラベルを付けない'}`, () => {
      assert.deepEqual(labelsFor(title), expected);
    });
  }

  test('タイトルを直すと付け直すよう、当たらなくなった規則のラベルを外す', () => {
    assert.equal(config['sync-labels'], true);
    assert.ok(workflow.on.pull_request_target.types.includes('edited'));
  });

  test('人が付ける release:breaking は自動の規則に入れない（sync-labels で外さない）', () => {
    assert.ok(!config.autolabeler.some((rule) => rule.labels.includes('release:breaking')));
  });
});

describe('版の上げ方とノートの分類', () => {
  test('タグと名前は vX.Y.Z', () => {
    assert.equal(config['tag-template'], 'v$RESOLVED_VERSION');
    assert.equal(config['name-template'], 'v$RESOLVED_VERSION');
  });

  test('release:feat は minor、release:fix は patch、release:breaking は major、ほかは patch', () => {
    const increments = Object.fromEntries(
      config.categories.filter((c) => c.when).map((c) => [c.when?.label, c['semver-increment']]),
    );
    assert.deepEqual(increments, { 'release:feat': 'minor', 'release:fix': 'patch', 'release:breaking': 'major' });
    const fallback = config.categories.filter((c) => c.type === 'version-resolver' && !c.when);
    assert.deepEqual(
      fallback.map((c) => c['semver-increment']),
      ['patch'],
    );
  });

  test('ノートは 新しい機能、直し、その他 の順に分け、ラベルの無い PR は その他 に入る', () => {
    const changelog = config.categories.filter((c) => (c.type ?? 'changelog') === 'changelog');
    assert.deepEqual(
      changelog.map((c) => c.title),
      ['新しい機能', '直し', 'その他'],
    );
    assert.equal(changelog.at(-1)?.when, undefined);
    assert.ok(changelog.slice(0, -1).every((c) => c.exclusive === true));
  });
});

describe('ワークフロー', () => {
  test('下書きは main への push だけで作り、ラベルは pull_request_target だけで付ける', () => {
    assert.deepEqual(workflow.on.push.branches, ['main']);
    assert.deepEqual([...workflow.on.pull_request_target.types].sort(), [
      'edited',
      'opened',
      'reopened',
      'synchronize',
    ]);
    assert.equal(runs(workflow.jobs.draft, 'push'), true);
    assert.equal(runs(workflow.jobs.draft, 'pull_request_target'), false);
    assert.equal(runs(workflow.jobs.autolabel, 'pull_request_target'), true);
    assert.equal(runs(workflow.jobs.autolabel, 'push'), false);
  });

  test('権限はジョブごとに最小にする', () => {
    assert.equal(workflow.permissions, undefined);
    assert.deepEqual(workflow.jobs.draft.permissions, { contents: 'write', 'pull-requests': 'read' });
    assert.deepEqual(workflow.jobs.autolabel.permissions, { contents: 'read', 'pull-requests': 'write' });
  });

  test('PR のコードを checkout しない', () => {
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(!job.steps.some((step) => step.uses?.startsWith('actions/checkout')));
    }
  });

  test('外部の action はコミットの SHA で固定する', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter((s) => s.uses)) {
        assert.match(step.uses ?? '', /@[0-9a-f]{40}$/);
      }
    }
  });

  test('下書きは publish せず、動いた push のコミットに固定する', () => {
    const drafter = workflow.jobs.draft.steps.find((s) => s.uses?.startsWith('release-drafter/release-drafter@'));
    assert.ok(drafter);
    assert.equal(drafter.with?.commitish, '${{ github.sha }}');
    assert.equal(drafter.with?.publish, undefined);
    assert.equal(drafter.with?.latest, undefined);
  });

  test('出した Release が無ければ v0.1.0、あれば前の版から上げる', () => {
    const drafter = workflow.jobs.draft.steps.find((s) => s.uses?.startsWith('release-drafter/release-drafter@'));
    const version = (count: string) =>
      runInNewContext(expression(drafter?.with?.version ?? ''), { steps: { published: { outputs: { count } } } });
    assert.equal(version('0'), '0.1.0');
    assert.equal(version('1'), '');
    assert.equal(version('12'), '');
  });

  test('出した Release が無ければ main の最初のコミットから拾い、あれば前の Release から拾う', () => {
    const drafter = workflow.jobs.draft.steps.find((s) => s.uses?.startsWith('release-drafter/release-drafter@'));
    const from = (count: string) =>
      runInNewContext(expression(drafter?.with?.from ?? ''), { steps: { published: { outputs: { count } } } });
    assert.match(from('0'), /^[0-9a-f]{40}$/);
    assert.equal(from('1'), '');
  });
});

describe('出した Release を数える段', () => {
  const step = workflow.jobs.draft.steps.find((s) => s.id === 'published');

  // gh を差し替えて、段のスクリプトをそのまま動かす
  function count(ghOutput: string, ghStatus = 0): { status: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'release-drafter-'));
    try {
      const gh = join(dir, 'gh');
      writeFileSync(gh, `#!/bin/sh\nprintf '%s' "$FAKE_GH_OUTPUT"\nexit ${ghStatus}\n`);
      chmodSync(gh, 0o755);
      const output = join(dir, 'output');
      writeFileSync(output, '');
      try {
        execFileSync('bash', ['-c', step?.run ?? ''], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            FAKE_GH_OUTPUT: ghOutput,
            GITHUB_OUTPUT: output,
            REPO: 'scrum-guild-dev/app',
          },
          stdio: 'pipe',
        });
        return { status: 0, output: readFileSync(output, 'utf8') };
      } catch (error) {
        return { status: (error as { status: number }).status, output: readFileSync(output, 'utf8') };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('出した Release が無ければ 0', () => {
    assert.deepEqual(count(''), { status: 0, output: 'count=0\n' });
  });

  test('1件なら 1（末尾に改行が無くても数える）', () => {
    assert.deepEqual(count('101'), { status: 0, output: 'count=1\n' });
  });

  test('複数なら件数', () => {
    assert.deepEqual(count('101\n102\n103\n'), { status: 0, output: 'count=3\n' });
  });

  test('API が落ちたら、0 と書かずに失敗する（v0.1.0 に戻さない）', () => {
    const result = count('', 1);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  });
});
