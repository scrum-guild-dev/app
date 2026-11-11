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
  'change-template': string;
  'category-template': string;
  'change-title-escapes': string;
  template: string;
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

// 条件をテスト側に書き直さず、YAML の if をそのまま評価する。使う演算子は JavaScript と共通
function runs(job: Job, eventName: string, event: Record<string, unknown> = {}): boolean {
  const condition = job.if.replace(/\s+/g, ' ');
  return Boolean(runInNewContext(`(${condition})`, { github: { event_name: eventName, event } }));
}

function prEvent(action: string, state = 'open', changes: Record<string, unknown> = {}) {
  return { action, pull_request: { state, number: 1 }, changes };
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
    ['feat:x', ['release:feat']],
    ['feat(): 空のスコープ', ['release:feat']],
    ['fix(api(v2)): 入れ子の括弧は読まない', []],
    ['feat：全角のコロン', []],
    ['feat (me): 種別の後の空白', []],
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
    assert.deepEqual([...workflow.on.pull_request_target.types].sort(), ['edited', 'opened', 'reopened']);
    assert.equal(runs(workflow.jobs.draft, 'push'), true);
    assert.equal(runs(workflow.jobs.draft, 'pull_request_target', prEvent('opened')), false);
    assert.equal(runs(workflow.jobs.autolabel, 'pull_request_target', prEvent('opened')), true);
    assert.equal(runs(workflow.jobs.autolabel, 'push'), false);
  });

  test('ラベルは開いた PR で、開いたとき、開き直したとき、タイトルを直したときだけ付ける', () => {
    const autolabel = workflow.jobs.autolabel;
    assert.equal(runs(autolabel, 'pull_request_target', prEvent('reopened')), true);
    assert.equal(
      runs(autolabel, 'pull_request_target', prEvent('edited', 'open', { title: { from: 'docs: a' } })),
      true,
    );
    // マージの後（閉じた PR）にタイトルを直しても、版の上げ方を変えさせない
    assert.equal(
      runs(autolabel, 'pull_request_target', prEvent('edited', 'closed', { title: { from: 'docs: a' } })),
      false,
    );
    // 本文の編集とベースの付け替えでは動かさない
    assert.equal(runs(autolabel, 'pull_request_target', prEvent('edited', 'open', { body: { from: '' } })), false);
    assert.equal(runs(autolabel, 'pull_request_target', prEvent('edited', 'open', { base: { ref: {} } })), false);
  });

  test('ラベルの段は PR ごとに最新の実行だけを残す', () => {
    assert.deepEqual(workflow.jobs.autolabel.concurrency, {
      group: 'release-autolabel-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    });
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
    // main の最初のコミット（親の無いコミット）。違う SHA にすると比べる API が 404 になり、下書きの段が落ち続ける
    assert.equal(from('0'), '3a8b99f62d026162454adedccad4c3397520f5d2');
    assert.equal(from('1'), '');
  });
});

describe('出した Release を数える段', () => {
  const step = workflow.jobs.draft.steps.find((s) => s.id === 'published');

  // gh を差し替えて、段のスクリプトをそのまま動かす。偽の gh は引数を残し、渡された --jq の式を
  // jq で Release の一覧（ページごとの JSON）に当てるので、式と引数を壊せばテストが落ちる
  type Release = { id: number; draft: boolean; prerelease: boolean };
  function count(pages: Release[][], ghStatus = 0): { status: number; output: string; args: string } {
    const dir = mkdtempSync(join(tmpdir(), 'release-drafter-'));
    try {
      const gh = join(dir, 'gh');
      writeFileSync(
        gh,
        [
          '#!/bin/bash',
          'printf \'%s\\n\' "$@" > "$FAKE_GH_DIR/args"',
          `[ ${ghStatus} -eq 0 ] || exit ${ghStatus}`,
          'while [ $# -gt 0 ]; do [ "$1" = --jq ] && expr="$2"; shift; done',
          'for page in "$FAKE_GH_DIR"/page-*.json; do [ -e "$page" ] && jq -r "$expr" "$page"; done',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(gh, 0o755);
      pages.forEach((page, index) => writeFileSync(join(dir, `page-${index}.json`), JSON.stringify(page)));
      const output = join(dir, 'output');
      writeFileSync(output, '');
      const result = (status: number) => ({
        status,
        output: readFileSync(output, 'utf8'),
        args: readFileSync(join(dir, 'args'), 'utf8'),
      });
      try {
        execFileSync('bash', ['-c', step?.run ?? ''], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            FAKE_GH_DIR: dir,
            GITHUB_OUTPUT: output,
            REPO: 'scrum-guild-dev/app',
          },
          stdio: 'pipe',
        });
        return result(0);
      } catch (error) {
        return result((error as { status: number }).status);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const published = (id: number): Release => ({ id, draft: false, prerelease: false });

  test('Release の一覧をすべてのページで読む', () => {
    const { args } = count([]);
    assert.ok(args.split('\n').includes('--paginate'));
    assert.ok(args.split('\n').includes('repos/scrum-guild-dev/app/releases?per_page=100'));
  });

  test('Release が無ければ 0', () => {
    assert.equal(count([]).output, 'count=0\n');
    assert.equal(count([[]]).output, 'count=0\n');
  });

  test('下書きとプレリリースだけなら 0（release-drafter も前の Release に使わない）', () => {
    assert.equal(
      count([
        [
          { id: 1, draft: true, prerelease: false },
          { id: 2, draft: false, prerelease: true },
        ],
      ]).output,
      'count=0\n',
    );
  });

  test('出した Release を、ページを跨いで数える', () => {
    assert.equal(count([[published(1)]]).output, 'count=1\n');
    assert.equal(
      count([
        [published(1), { id: 2, draft: true, prerelease: false }],
        [published(3), published(4)],
      ]).output,
      'count=3\n',
    );
  });

  test('API が落ちたら、0 と書かずに失敗する（v0.1.0 と最初のコミットに戻さない）', () => {
    const result = count([], 1);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  });
});

describe('ノートの形', () => {
  test('節は ### の見出し、行は「- <タイトル> (#<PR の番号>)」', () => {
    assert.equal(config['category-template'], '### $TITLE');
    assert.equal(config['change-template'], '- $TITLE (#$NUMBER)');
    assert.ok(config.template.includes('$CHANGES'));
  });

  test('強調、メンション、リンク、画像、打ち消し線の記号をエスケープし、# と ( ) は残す', () => {
    for (const c of ['\\', '<', '*', '_', '&', '@', '[', ']', '!', '~']) {
      assert.ok(config['change-title-escapes'].includes(c), c);
    }
    for (const c of ['#', '(', ')', '`']) {
      assert.ok(!config['change-title-escapes'].includes(c), c);
    }
  });
});

describe('main の先頭の push かを確かめる段', () => {
  const step = workflow.jobs.draft.steps.find((s) => s.id === 'head');

  function latest(head: string, sha: string, ghStatus = 0): { status: number; output: string; args: string } {
    const dir = mkdtempSync(join(tmpdir(), 'release-drafter-head-'));
    try {
      const gh = join(dir, 'gh');
      writeFileSync(
        gh,
        [
          '#!/bin/bash',
          'printf \'%s\\n\' "$@" > "$FAKE_GH_DIR/args"',
          `[ ${ghStatus} -eq 0 ] || exit ${ghStatus}`,
          `echo ${head}`,
          '',
        ].join('\n'),
      );
      chmodSync(gh, 0o755);
      const output = join(dir, 'output');
      writeFileSync(output, '');
      let status = 0;
      try {
        execFileSync('bash', ['-c', step?.run ?? ''], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            FAKE_GH_DIR: dir,
            GITHUB_OUTPUT: output,
            REPO: 'scrum-guild-dev/app',
            SHA: sha,
          },
          stdio: 'pipe',
        });
      } catch (error) {
        status = (error as { status: number }).status;
      }
      return { status, output: readFileSync(output, 'utf8'), args: readFileSync(join(dir, 'args'), 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('main の先頭を API で読む', () => {
    assert.ok(
      latest('a'.repeat(40), 'a'.repeat(40)).args.split('\n').includes('repos/scrum-guild-dev/app/commits/main'),
    );
    assert.equal(step?.with, undefined);
  });

  test('動いた push が main の先頭なら作り直す', () => {
    assert.deepEqual(latest('a'.repeat(40), 'a'.repeat(40)).output, 'latest=true\n');
  });

  test('main が先に進んでいれば（古い実行の走らせ直し）何もしない', () => {
    assert.deepEqual(latest('b'.repeat(40), 'a'.repeat(40)).output, 'latest=false\n');
  });

  test('API が落ちたら、作り直さずに失敗する', () => {
    const result = latest('', 'a'.repeat(40), 1);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  });

  test('続く段は main の先頭のときだけ動く', () => {
    const rest = workflow.jobs.draft.steps.filter((s) => s.id !== 'head');
    assert.ok(rest.length >= 2);
    for (const s of rest) assert.equal((s as Step & { if?: string }).if, "steps.head.outputs.latest == 'true'");
  });

  test('下書きの段は1つずつ動かし、動いている実行を取り消さない', () => {
    assert.deepEqual(workflow.jobs.draft.concurrency, { group: 'release-drafter', 'cancel-in-progress': false });
  });
});
