// Release の publish で、本番用のブランチ production をタグのコミットへ進めてよいかの判定（.github/workflows/release.yml）。
// 判定はここに置き、ワークフローには手順を持たない（docs/development.md の「ブランチ戦略」と「CI」）。
// 依存パッケージを導入せずに動かす。
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { RELEASE_TAG } from './release-version.ts';

// 形はビルドとデプロイ（scripts/release-version.ts）と同じにする。ずれると production だけが進み、ビルドが版を決められずに止まる
export const VERSION_TAG = RELEASE_TAG;
const SHA = /^[0-9a-f]{40}$/;
// 完全な名前で渡す。origin/main のままだと、同じ名前のタグ（refs/tags/origin/main）が先に当たり、main の判定を偽れる
export const MAIN_REF = 'refs/remotes/origin/main';

export type Release = { tag: string; draft: boolean; prerelease: boolean };

// git の問い合わせ。テストでは作り物を渡す
export type Git = {
  // タグのコミットの SHA。無ければ undefined
  tagCommit(tag: string): string | undefined;
  // origin/production の SHA。無ければ undefined
  production(): string | undefined;
  // ancestor が descendant の祖先か（同じコミットも祖先に数える。git merge-base --is-ancestor と同じ）
  isAncestor(ancestor: string, descendant: string): boolean;
};

export type Decision = { ok: true; commit: string; from: string } | { ok: false; reason: string };

export function decide(release: Release, git: Git): Decision {
  // タグの名前は git に渡す前に形で絞る（Release を作れる人なら、任意の名前を付けられる）
  if (!VERSION_TAG.test(release.tag))
    return { ok: false, reason: `タグ ${JSON.stringify(release.tag)} が vX.Y.Z の形でない` };
  if (release.draft) return { ok: false, reason: `${release.tag} は下書き（draft）` };
  if (release.prerelease) return { ok: false, reason: `${release.tag} はプレリリース。本番には出さない` };
  const commit = git.tagCommit(release.tag);
  if (!commit || !SHA.test(commit)) return { ok: false, reason: `タグ ${release.tag} のコミットを引けない` };
  if (!git.isAncestor(commit, MAIN_REF)) {
    return {
      ok: false,
      reason: `${release.tag}（${commit}）は origin/main に入っていない。main に入ったコミットだけを出す`,
    };
  }
  const from = git.production();
  if (!from || !SHA.test(from))
    return { ok: false, reason: 'origin/production を引けない。先に人が production ブランチを作る' };
  if (from === commit) return { ok: false, reason: `production は既に ${release.tag}（${commit}）を指している` };
  if (!git.isAncestor(from, commit)) {
    return {
      ok: false,
      reason: `production（${from}）が ${release.tag}（${commit}）の祖先でない。古い版か枝分かれしたコミットへは動かさない`,
    };
  }
  return { ok: true, commit, from };
}

// ワークフローで使う git。fetch-depth: 0 で取った作業コピーで動かす
export function localGit(cwd = process.cwd()): Git {
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const revParse = (ref: string) => {
    try {
      return run('rev-parse', '--verify', '--quiet', ref).trim();
    } catch {
      return undefined;
    }
  };
  return {
    tagCommit: (tag) => revParse(`refs/tags/${tag}^{commit}`),
    production: () => revParse('refs/remotes/origin/production^{commit}'),
    isAncestor(ancestor, descendant) {
      try {
        run('merge-base', '--is-ancestor', ancestor, descendant);
        return true;
      } catch (error) {
        // 1 は「祖先でない」。それ以外（引けない ref など）は判定できないので投げる
        if ((error as { status?: number }).status === 1) return false;
        throw error;
      }
    },
  };
}

// GitHub の release のイベントから判定に使う値を取る
export function releaseOf(event: unknown): Release {
  const release = (event as { release?: { tag_name?: unknown; draft?: unknown; prerelease?: unknown } }).release;
  return {
    tag: typeof release?.tag_name === 'string' ? release.tag_name : '',
    // 値が無いときは出さない側に倒す
    draft: release?.draft !== false,
    prerelease: release?.prerelease !== false,
  };
}

// node scripts/release-production.ts <event.json>。進めてよければ GITHUB_OUTPUT に commit と tag を書く
export function main(eventPath: string, git: Git, output: string | undefined): number {
  try {
    const release = releaseOf(JSON.parse(readFileSync(eventPath, 'utf8')));
    const decision = decide(release, git);
    if (!decision.ok) {
      console.error(`::error::production を進めない: ${decision.reason}`);
      return 1;
    }
    console.log(`production を ${decision.from} から ${release.tag}（${decision.commit}）へ進める`);
    if (output) appendFileSync(output, `commit=${decision.commit}\ntag=${release.tag}\n`);
    return 0;
  } catch (error) {
    // イベントを読めない、git が予期しない失敗をした。判定できないので進めない
    console.error(
      `::error::production を進めるかを判定できない: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(
    process.argv[2] ?? process.env.GITHUB_EVENT_PATH ?? '',
    localGit(),
    process.env.GITHUB_OUTPUT,
  );
}
