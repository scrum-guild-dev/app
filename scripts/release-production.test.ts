import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { load } from 'js-yaml';
import { decide, type Git, localGit, MAIN_REF, main, releaseOf } from './release-production.ts';

// Release の publish で production を進めてよいかの判定（docs/development.md の「ブランチ戦略」）

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

// 祖先関係を [祖先, 子孫] の組で渡す作り物の git。同じコミットは祖先に数える
function fakeGit({
  tags = { 'v0.1.0': B } as Record<string, string>,
  production = A as string | undefined,
  edges = [[A, B]] as [string, string][],
  main = [A, B],
} = {}): Git {
  return {
    tagCommit: (tag) => tags[tag],
    production: () => production,
    isAncestor(ancestor, descendant) {
      if (descendant === MAIN_REF) return main.includes(ancestor);
      return ancestor === descendant || edges.some(([x, y]) => x === ancestor && y === descendant);
    },
  };
}

const published = { tag: 'v0.1.0', draft: false, prerelease: false };

describe('decide', () => {
  test('タグが main に入っていて、production がその真の祖先なら進める', () => {
    assert.deepEqual(decide(published, fakeGit()), { ok: true, commit: B, from: A });
  });

  for (const tag of [
    '0.1.0',
    'v0.1',
    'v0.1.0-rc.1',
    'v0.1.0 ',
    'v01.a.0',
    'release-1',
    '',
    'v0.1.0\n',
    '-v0.1.0',
    // ビルド（scripts/release-version.ts）が版にしないタグも断る。通すと production だけが進み、ビルドが止まる
    'v01.0.0',
    'v0.01.0',
    'v0.1.00',
    'v1.0.9007199254740993',
  ]) {
    test(`タグ ${JSON.stringify(tag)} は vX.Y.Z の形でないので断る`, () => {
      const decision = decide({ ...published, tag }, fakeGit({ tags: { [tag]: B } }));
      assert.equal(decision.ok, false);
      assert.match(!decision.ok ? decision.reason : '', /vX\.Y\.Z/);
    });
  }

  test('下書きは断る', () => {
    const decision = decide({ ...published, draft: true }, fakeGit());
    assert.equal(decision.ok, false);
    assert.match(!decision.ok ? decision.reason : '', /下書き/);
  });

  test('プレリリースは断る', () => {
    const decision = decide({ ...published, prerelease: true }, fakeGit());
    assert.equal(decision.ok, false);
    assert.match(!decision.ok ? decision.reason : '', /プレリリース/);
  });

  test('タグのコミットを引けなければ断る', () => {
    const decision = decide(published, fakeGit({ tags: {} }));
    assert.equal(decision.ok, false);
  });

  test('タグのコミットが origin/main の祖先でなければ断る', () => {
    const decision = decide(published, fakeGit({ main: [A] }));
    assert.equal(decision.ok, false);
    assert.match(!decision.ok ? decision.reason : '', /origin\/main に入っていない/);
  });

  for (const production of ['', 'HEAD', 'a'.repeat(39)]) {
    test(`production が ${JSON.stringify(production)} なら断る`, () => {
      const decision = decide(published, fakeGit({ production }));
      assert.equal(decision.ok, false);
      assert.match(!decision.ok ? decision.reason : '', /production/);
    });
  }
  test('production が無ければ断る', () => {
    const git = { ...fakeGit(), production: () => undefined };
    assert.equal(decide(published, git).ok, false);
  });
  test('タグのコミットが SHA の形でなければ断る', () => {
    assert.equal(decide(published, fakeGit({ tags: { 'v0.1.0': 'main' } })).ok, false);
  });

  test('production がタグと同じコミットなら断る', () => {
    const decision = decide(published, fakeGit({ production: B }));
    assert.equal(decision.ok, false);
    assert.match(!decision.ok ? decision.reason : '', /既に/);
  });

  test('巻き戻し（production がタグより先）は断る', () => {
    // A ← B で production が B、タグが A
    const decision = decide(published, fakeGit({ tags: { 'v0.1.0': A }, production: B }));
    assert.equal(decision.ok, false);
    assert.match(!decision.ok ? decision.reason : '', /祖先でない/);
  });

  test('枝分かれ（production がタグの祖先でも子孫でもない）は断る', () => {
    const decision = decide(
      published,
      fakeGit({
        production: C,
        edges: [
          [A, B],
          [A, C],
        ],
      }),
    );
    assert.equal(decision.ok, false);
    assert.match(!decision.ok ? decision.reason : '', /祖先でない/);
  });
});

describe('releaseOf', () => {
  test('release のイベントから値を取る', () => {
    assert.deepEqual(releaseOf({ release: { tag_name: 'v1.2.3', draft: false, prerelease: false } }), {
      tag: 'v1.2.3',
      draft: false,
      prerelease: false,
    });
  });
  test('値が無ければ出さない側に倒す', () => {
    assert.deepEqual(releaseOf({}), { tag: '', draft: true, prerelease: true });
    assert.equal(decide(releaseOf({ release: { tag_name: 'v1.2.3' } }), fakeGit()).ok, false);
  });
});

describe('localGit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-production-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  // origin に main（first ← second ← third）と production（first）、枝分かれのコミット other を置き、clone した作業コピーで判定する
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'init', '-b', 'main', seed);
  git(seed, 'commit', '--allow-empty', '-m', 'first');
  const first = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'commit', '--allow-empty', '-m', 'second');
  const second = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'commit', '--allow-empty', '-m', 'third');
  git(seed, 'branch', 'production', first);
  git(seed, 'checkout', '-b', 'other', first);
  git(seed, 'commit', '--allow-empty', '-m', 'other');
  // 注釈付きのタグ（GitHub の Release が作るのは軽量のタグだが、どちらでもコミットを引く）
  git(seed, 'tag', '-a', '-m', 'v0.1.0', 'v0.1.0', second);
  git(seed, 'tag', 'v0.0.9', first);
  git(seed, 'tag', 'v9.9.9', 'other');
  // main に入っていないコミットを指す origin/main という名前のタグ。短い名前で比べると、このタグが先に当たる
  git(seed, 'tag', 'origin/main', 'other');
  git(seed, 'push', remote, 'main', 'production', '--tags');
  git(root, 'clone', remote, work);

  test('main に入ったタグで、production の真の子孫なら進める', () => {
    assert.deepEqual(decide(published, localGit(work)), { ok: true, commit: second, from: first });
  });
  test('origin/main という名前のタグがあっても、main に入っていないタグは断る', () => {
    assert.equal(decide({ ...published, tag: 'v9.9.9' }, localGit(work)).ok, false);
  });
  test('production と同じコミットのタグは断る', () => {
    assert.equal(decide({ ...published, tag: 'v0.0.9' }, localGit(work)).ok, false);
  });
  test('無いタグは断る', () => {
    assert.equal(decide({ ...published, tag: 'v1.0.0' }, localGit(work)).ok, false);
  });
});

describe('main', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'release-production-main-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const event = path.join(dir, 'event.json');
  const output = path.join(dir, 'output');
  const quiet = <T>(fn: () => T): T => {
    const { error, log } = console;
    console.error = () => {};
    console.log = () => {};
    try {
      return fn();
    } finally {
      Object.assign(console, { error, log });
    }
  };

  test('進めてよければ 0 で終え、GITHUB_OUTPUT に commit と tag を書く', () => {
    writeFileSync(event, JSON.stringify({ release: published }).replace('"tag"', '"tag_name"'));
    writeFileSync(output, '');
    assert.equal(
      quiet(() => main(event, fakeGit(), output)),
      0,
    );
    assert.equal(readFileSync(output, 'utf8'), `commit=${B}\ntag=v0.1.0\n`);
  });
  test('断れば 1 で終え、GITHUB_OUTPUT に書かない', () => {
    writeFileSync(event, JSON.stringify({ release: { tag_name: 'v0.1.0', draft: true, prerelease: false } }));
    writeFileSync(output, '');
    assert.equal(
      quiet(() => main(event, fakeGit(), output)),
      1,
    );
    assert.equal(readFileSync(output, 'utf8'), '');
  });
  test('イベントを読めない、git が投げたときは 1 で終える', () => {
    assert.equal(
      quiet(() => main(path.join(dir, 'missing.json'), fakeGit(), output)),
      1,
    );
    writeFileSync(event, JSON.stringify({ release: { tag_name: 'v0.1.0', draft: false, prerelease: false } }));
    const broken = {
      ...fakeGit(),
      isAncestor: () => {
        throw new Error('fatal');
      },
    };
    assert.equal(
      quiet(() => main(event, broken, output)),
      1,
    );
  });
});

describe('.github/workflows/release.yml', () => {
  type Step = {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
    id?: string;
  };
  const workflow = load(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')) as {
    on: { release: { types: string[] } };
    permissions: Record<string, string>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<string, { steps: Step[]; permissions?: unknown; environment?: string }>;
  };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const runs = steps.map((step) => step.run ?? '').join('\n');

  test('release の published だけで動く', () => {
    assert.deepEqual(Object.keys(workflow.on), ['release']);
    assert.deepEqual(workflow.on.release.types, ['published']);
  });
  test('App の鍵は Environment release から読む', () => {
    assert.deepEqual(
      Object.values(workflow.jobs).map((job) => job.environment),
      ['release'],
    );
  });
  test('GITHUB_TOKEN は contents: read だけ', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    for (const job of Object.values(workflow.jobs)) assert.equal(job.permissions, undefined);
  });
  test('1本ずつ走らせ、進行中の実行を取り消さない', () => {
    assert.equal(workflow.concurrency.group, 'release-production');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });
  test('push の step は判定の出力を env で受け、トークンを URL に入れない', () => {
    const push = steps.find((s) => s.run?.includes('refs/heads/production'));
    const decideStep = steps.find((s) => s.run?.includes('release-production.ts'));
    const vars = push?.['env'];
    assert.equal(decideStep?.id, 'decide');
    assert.equal(vars?.COMMIT, '${{ steps.decide.outputs.commit }}');
    assert.equal(vars?.TAG, '${{ steps.decide.outputs.tag }}');
    assert.equal(vars?.TOKEN, '${{ steps.token.outputs.token }}');
    assert.match(push?.run ?? '', /\$\{COMMIT:\?/);
    assert.doesNotMatch(push?.run ?? '', /@github\.com/);
  });
  test('action はコミットの SHA で固定する', () => {
    for (const step of steps.filter((s) => s.uses))
      assert.match(step.uses ?? '', /@[0-9a-f]{40}( |$)/, String(step.uses));
  });
  test('判定を通してから、force 無しで production へ push する', () => {
    assert.match(runs, /node scripts\/release-production\.ts/);
    assert.match(runs, /git push [^\n]*:refs\/heads\/production/);
    assert.doesNotMatch(runs, /--force|\+[^\s]*:refs\/heads\/production| -f\b/);
    const decideAt = steps.findIndex((s) => s.run?.includes('release-production.ts'));
    const tokenAt = steps.findIndex((s) => s.uses?.startsWith('actions/create-github-app-token@'));
    const pushAt = steps.findIndex((s) => s.run?.includes('refs/heads/production'));
    assert.ok(decideAt !== -1 && decideAt < tokenAt && tokenAt < pushAt, '判定、トークン、push の順');
  });
  test('App のトークンは contents と workflows の書き込みだけに絞る', () => {
    const token = steps.find((s) => s.uses?.startsWith('actions/create-github-app-token@'));
    assert.equal(token?.with?.['permission-contents'], 'write');
    assert.equal(token?.with?.['permission-workflows'], 'write');
    assert.deepEqual(
      Object.keys(token?.with ?? {})
        .filter((k) => k.startsWith('permission-'))
        .sort(),
      ['permission-contents', 'permission-workflows'],
    );
  });
  test('判定のスクリプトはイベントの ref ではなく main の版で動かし、資格情報を作業コピーに残さない', () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.ref, 'main');
    assert.equal(String(checkout?.with?.['persist-credentials']), 'false');
    assert.equal(String(checkout?.with?.['fetch-depth']), '0');
  });
  test('run の中に ${{ }} の式を直に書かない（値は env で渡す）', () => {
    assert.doesNotMatch(runs, /\$\{\{/);
  });
});
