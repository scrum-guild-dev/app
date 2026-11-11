// 本番の版を、HEAD を指す Release のタグ（vX.Y.Z）から決める（docs/development.md の「版」）。
// Workers Builds のビルドのコマンド（APP_VERSION=$(node scripts/release-version.ts)）とデプロイのスクリプトが同じ関数を使う。
// 版の正はタグだけにし、package.json の version には持たない
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Release のタグの形。先頭の 0 と、プレリリースやビルドの付記（v1.0.0-rc.1 など）は版にしない
export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type GitResult = { status: number; stdout: string; stderr: string };
export type Git = (args: string[]) => GitResult;
export type ReleaseVersion = { ok: true; version: string } | { ok: false; reason: string };

function parts(tag: string): [number, number, number] {
  const match = RELEASE_TAG.exec(tag)!;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// タグの並びから最大の版を返す。形の違うタグは無視し、1つも無ければ undefined
export function latestReleaseTag(tags: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const tag of tags) {
    if (!RELEASE_TAG.test(tag)) continue;
    if (best === undefined) {
      best = tag;
      continue;
    }
    const [a, b] = [parts(tag), parts(best)];
    const diff = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (diff > 0) best = tag;
  }
  return best;
}

function tagsAtHead(git: Git): { ok: true; tags: string[] } | { ok: false; reason: string } {
  const result = git(['tag', '--points-at', 'HEAD']);
  if (result.status !== 0)
    return { ok: false, reason: `git tag --points-at HEAD に失敗しました: ${result.stderr.trim()}` };
  return { ok: true, tags: result.stdout.split('\n').map((line) => line.trim()) };
}

// HEAD を指す vX.Y.Z のタグから版を決める。checkout にタグが無ければ origin からタグを取ってから読み直す
// （Workers Builds の checkout にタグが付いてくるかは確かめていないため）。それでも無ければ失敗にする
export function resolveReleaseVersion(git: Git): ReleaseVersion {
  const first = tagsAtHead(git);
  if (!first.ok) return first;
  const found = latestReleaseTag(first.tags);
  if (found) return { ok: true, version: found };

  const fetched = git(['fetch', '--tags', '--no-recurse-submodules', 'origin']);
  if (fetched.status !== 0) {
    return {
      ok: false,
      reason: `HEAD を指す vX.Y.Z のタグが無く、git fetch --tags origin に失敗しました: ${fetched.stderr.trim()}`,
    };
  }
  const second = tagsAtHead(git);
  if (!second.ok) return second;
  const afterFetch = latestReleaseTag(second.tags);
  if (afterFetch) return { ok: true, version: afterFetch };
  return {
    ok: false,
    reason: 'HEAD を指す vX.Y.Z のタグがありません。Release の publish で進めたコミットだけを本番に出します',
  };
}

export const spawnGit: Git = (args) => {
  const result = spawnSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error) return { status: 1, stdout: '', stderr: result.error.message };
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

// import.meta.main が無い Node（古い版）で直に動かすと、何も出さずに成功に見え、空の版でビルドが進む。理由を出して失敗させる。
// deploy.ts からの import では止めない
if (
  typeof import.meta.main !== 'boolean' &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.error('import.meta.main が使えない Node です。.node-version の版の Node で動かしてください');
  process.exit(1);
}

// ビルドのコマンドから直に動かしたときだけ、版を標準出力に1行で出す。決められなければ理由を出して終了コード 1
if (import.meta.main) {
  const resolved = resolveReleaseVersion(spawnGit);
  if (resolved.ok) {
    console.log(resolved.version);
  } else {
    console.error(resolved.reason);
    process.exit(1);
  }
}
