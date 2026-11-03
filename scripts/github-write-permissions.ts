// GitHub の区分（MEMBER、COLLABORATOR など）ではなく、対象リポジトリへの実権限を確認する。
// lookup を分け、API の失敗と不正な応答をネットワークなしで確かめる。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type User = { login?: string | null; type?: string | null };
type PermissionLookup = (login: string) => Promise<unknown>;
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['write', 'maintain', 'admin']);
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export function normalizeLogin(value: unknown): string | undefined {
  return typeof value === 'string' && LOGIN.test(value) ? value.toLowerCase() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function resolveWriteUsers(
  users: readonly User[],
  lookup: PermissionLookup,
): Promise<ReadonlySet<string>> {
  const checked = new Set<string>();
  const writers = new Set<string>();
  for (const user of users) {
    const login = normalizeLogin(user?.login);
    if (user?.type !== 'User' || login === undefined || checked.has(login)) continue;
    checked.add(login);
    try {
      const response = record(await lookup(login));
      const found = record(response?.user);
      if (
        found?.type === 'User' &&
        normalizeLogin(found.login) === login &&
        typeof response?.permission === 'string' &&
        WRITE_PERMISSIONS.has(response.permission)
      ) {
        writers.add(login);
      }
    } catch {
      // 取得できない人を区分で補って許可しない。ほかの人の確認は続ける。
    }
  }
  return writers;
}

function readUsers(rawDir: string): User[] {
  const result: User[] = [];
  for (const name of ['pr.json', 'issue-comments.json', 'review-comments.json']) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(rawDir, name), 'utf8'));
      const values: unknown[] = Array.isArray(raw) ? raw.flat() : [raw];
      for (const value of values) {
        const user = record(record(value)?.user);
        if (user?.type === 'User' && typeof user.login === 'string') {
          result.push({ login: user.login, type: user.type });
        }
      }
    } catch {
      // 補助情報は読めたファイルだけを使う。本文や API の応答をログに出さない。
    }
  }
  return result;
}

if (import.meta.main) {
  const [rawDir, outFile] = process.argv.slice(2);
  if (!rawDir || !outFile) {
    console.error(
      '使い方: node scripts/github-write-permissions.ts <取得した JSON のディレクトリ> <確認済み login の JSON>',
    );
    process.exit(1);
  }
  // 途中で落ちても古い確認済み集合を使わない。
  writeFileSync(outFile, '[]');
  const repo = process.env.REPO ?? '';
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo)) {
    console.error('::warning::書き込み権限を確認するリポジトリが不正');
    process.exit(1);
  }
  const writers = await resolveWriteUsers(readUsers(rawDir), async (login) => {
    const response = spawnSync('gh', ['api', `repos/${repo}/collaborators/${login}/permission`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (response.error || response.status !== 0) throw new Error('権限を取得できなかった');
    return JSON.parse(response.stdout) as unknown;
  });
  writeFileSync(outFile, JSON.stringify([...writers]));
  console.log(`書き込み権限を確認した人数: ${writers.size}`);
}
