// PAT（fine-grained）で呼ぶ GitHub の API の偽物。ログインの偽物（test/auth/fake-github.ts）とは別。
// GET /user と GET /user/repos だけを持つ。受けた呼び出しを記録し、次の1回の失敗や、n 頁目の失敗を差し込める。
// 例のデータはすべて架空
export const FAKE_PAT_USER_URL = 'https://api.github.com/user';
export const FAKE_PAT_REPOS_URL = 'https://api.github.com/user/repos';

// 形が合う架空の PAT（`github_pat_` + 英数字とアンダースコア）。seed が違えば別の値
export function fakePat(seed: string): string {
  return `github_pat_FAKE${seed.replaceAll(/[^A-Za-z0-9]/g, '')}0123456789abcdefABCDEF`;
}

export type FakeOwner = { type: string; id: number; login: string };
export type FakeRepo = { id: number; full_name: string };

export type FakeFailure =
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'network'; message?: string }
  | { kind: 'not-json' }
  | { kind: 'redirect'; status?: number }
  | { kind: 'body'; body: unknown };

export type FakePatCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  hasSignal: boolean;
};

export const FAKE_FAILURE_MARK = 'SECRET-MARK-9f3a';

export function createFakePatGithub() {
  const accounts = new Map<string, { owner: FakeOwner; repos: unknown[] }>();
  const calls: FakePatCall[] = [];
  let next: FakeFailure | undefined;
  const pageFailures = new Map<number, FakeFailure>();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function fail(failure: FakeFailure): Response {
    switch (failure.kind) {
      case 'status':
        return new Response(failure.body ?? `upstream ${FAKE_FAILURE_MARK}`, { status: failure.status });
      case 'network':
        throw new Error(failure.message ?? `connection reset ${FAKE_FAILURE_MARK}`);
      case 'not-json':
        return new Response(`<html>${FAKE_FAILURE_MARK}</html>`, { status: 200 });
      case 'redirect':
        return new Response(null, {
          status: failure.status ?? 302,
          headers: { Location: `https://evil.example/${FAKE_FAILURE_MARK}` },
        });
      case 'body':
        return json(failure.body);
    }
  }

  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      method: init?.method ?? 'GET',
      url,
      headers,
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    });

    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page') ?? '1');
    const isRepos = parsed.origin + parsed.pathname === FAKE_PAT_REPOS_URL;

    if (next !== undefined) {
      const failure = next;
      next = undefined;
      return fail(failure);
    }
    if (isRepos) {
      const pageFailure = pageFailures.get(page);
      if (pageFailure !== undefined) {
        pageFailures.delete(page);
        return fail(pageFailure);
      }
    }

    const account = accounts.get((headers['authorization'] ?? '').replace(/^Bearer /, ''));
    if (account === undefined) return json({ message: 'Bad credentials' }, 401);
    if (parsed.origin + parsed.pathname === FAKE_PAT_USER_URL) return json(account.owner);
    if (isRepos) {
      const perPage = Math.min(Number(parsed.searchParams.get('per_page') ?? '30'), 100);
      return json(account.repos.slice((page - 1) * perPage, page * perPage));
    }
    return json({ message: 'Not Found' }, 404);
  };

  return {
    fetcher,
    calls,
    // PAT ごとの持ち主とリポジトリ。repos の要素は壊れた形も入れられる
    addAccount(pat: string, owner: FakeOwner, repos: unknown[] = []): void {
      accounts.set(pat, { owner, repos });
    },
    // 次の1回の呼び出し（どの URL でも）を失敗させる
    failNext(failure: FakeFailure): void {
      next = failure;
    },
    // /user/repos の n 頁目（1回だけ）を失敗させる
    failOnPage(page: number, failure: FakeFailure): void {
      pageFailures.set(page, failure);
    },
  };
}

export type FakePatGithub = ReturnType<typeof createFakePatGithub>;

// 架空のリポジトリの一覧。id は offset から連番
export function fakeRepos(count: number, offset = 1000): FakeRepo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: offset + i,
    full_name: `guild-fake/repo-${offset + i}`,
  }));
}
