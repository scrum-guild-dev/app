import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { latestReleaseTag, resolveReleaseVersion, type Git, type GitResult } from './release-version.ts';

const ok = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '' });

// git tag --points-at HEAD は tags を順に返し、尽きたら最後の値を返し続ける
function fakeGit(options: { tags: string[]; fetch?: GitResult }): { git: Git; calls: string[][] } {
  const calls: string[][] = [];
  let tagCalls = 0;
  return {
    calls,
    git: (args) => {
      calls.push(args);
      if (args[0] === 'tag') return ok(options.tags[Math.min(tagCalls++, options.tags.length - 1)]);
      if (args[0] === 'fetch') return options.fetch ?? ok();
      throw new Error(`想定外の git の呼び出し: ${args.join(' ')}`);
    },
  };
}

describe('latestReleaseTag', () => {
  test('タグが無ければ undefined', () => {
    assert.equal(latestReleaseTag([]), undefined);
    assert.equal(latestReleaseTag(['']), undefined);
  });

  test('1つならそれを返す', () => {
    assert.equal(latestReleaseTag(['v0.1.0']), 'v0.1.0');
  });

  test('複数なら数として最大の版を返す（文字の順ではない）', () => {
    assert.equal(latestReleaseTag(['v0.9.0', 'v0.10.0', 'v0.2.3']), 'v0.10.0');
    assert.equal(latestReleaseTag(['v1.0.0', 'v0.99.99']), 'v1.0.0');
    assert.equal(latestReleaseTag(['v1.2.9', 'v1.2.10']), 'v1.2.10');
  });

  test('形の違うタグは無視する', () => {
    const others = [
      '0.1.0',
      'v0.1',
      'v01.0.0',
      'v0.1.0-rc.1',
      'v0.1.0+build',
      'V0.1.0',
      'release',
      'v9.9.9 ',
      'v1.0.0\n',
    ];
    assert.equal(latestReleaseTag(others), undefined);
    assert.equal(latestReleaseTag([...others, 'v0.2.0']), 'v0.2.0');
  });
});

describe('resolveReleaseVersion', () => {
  test('HEAD を指すタグがあれば、fetch せずにその版を返す', () => {
    const { git, calls } = fakeGit({ tags: ['v0.1.0\n'] });
    assert.deepEqual(resolveReleaseVersion(git), { ok: true, version: 'v0.1.0' });
    assert.deepEqual(calls, [['tag', '--points-at', 'HEAD']]);
  });

  test('複数のタグが HEAD を指せば最大の版を返し、形の違うタグは無視する', () => {
    const { git } = fakeGit({ tags: ['v0.1.0\nv0.10.0\nv0.9.0\nv1.0.0-rc.1\nlatest\n'] });
    assert.deepEqual(resolveReleaseVersion(git), { ok: true, version: 'v0.10.0' });
  });

  test('checkout にタグが無ければ origin からタグを取って読み直す', () => {
    const { git, calls } = fakeGit({ tags: ['', 'v0.2.0\n'] });
    assert.deepEqual(resolveReleaseVersion(git), { ok: true, version: 'v0.2.0' });
    assert.deepEqual(calls, [
      ['tag', '--points-at', 'HEAD'],
      ['fetch', '--tags', '--no-recurse-submodules', 'origin'],
      ['tag', '--points-at', 'HEAD'],
    ]);
  });

  test('取った後もタグが無ければ失敗する', () => {
    const { git } = fakeGit({ tags: ['', 'v0.1.0-rc.1\n'] });
    const result = resolveReleaseVersion(git);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /HEAD を指す vX\.Y\.Z のタグがありません/);
  });

  test('タグを取れなければ失敗する', () => {
    const { git } = fakeGit({ tags: [''], fetch: { status: 128, stdout: '', stderr: 'fatal: could not read' } });
    const result = resolveReleaseVersion(git);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /git fetch --tags origin に失敗しました: fatal: could not read/);
  });

  test('git tag が失敗すれば fetch せずに失敗する', () => {
    const calls: string[][] = [];
    const result = resolveReleaseVersion((args) => {
      calls.push(args);
      return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });
});

describe('release-version.ts を直に動かす', () => {
  const script = fileURLToPath(new URL('./release-version.ts', import.meta.url));

  // GIT_DIR などを継いでいると、使い捨てではなく呼び出し元のリポジトリを書き換えるので外す
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

  // 使い捨ての git のリポジトリで、ビルドのコマンドと同じように動かす。origin は持たない
  function repo(setup: (git: (...args: string[]) => void) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-version-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv,
      });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
    setup(git);
    try {
      return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: cleanEnv });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('HEAD を指す最大の版を1行で出す', () => {
    const result = repo((git) => {
      git('tag', 'v0.1.0');
      git('tag', 'v0.1.1');
      git('tag', 'other');
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'v0.1.1\n');
  });

  test('HEAD にタグが無ければ何も出さずに終了コード 1 で終わる', () => {
    const result = repo((git) => {
      git('tag', 'v0.1.0');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'second');
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /git fetch --tags origin に失敗しました/);
  });
});
