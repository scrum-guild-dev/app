// GitHub の取り込み元（fine-grained PAT）の確かめと範囲の候補の一覧。偽物の GitHub に fetcher を差し、実装を直に呼ぶ
import { describe, expect, test } from 'vitest';
import { ImportSourceError, importSourceOf, isImportSourceKind } from '../../src/server/import/index.ts';
import type { ImportSourceFailure } from '../../src/server/import/index.ts';
import {
  FAKE_FAILURE_MARK,
  FAKE_PAT_REPOS_URL,
  FAKE_PAT_USER_URL,
  createFakePatGithub,
  fakePat,
  fakeRepos,
} from './fake-github-pat.ts';
import type { FakeFailure } from './fake-github-pat.ts';

const source = importSourceOf('github');
const PAT = fakePat('Alpha');
const OWNER = { type: 'User', id: 4242, login: 'fake-ranger' };

function setup(repos: unknown[] = fakeRepos(3)) {
  const fake = createFakePatGithub();
  fake.addAccount(PAT, OWNER, repos);
  return fake;
}

async function failureOf(work: Promise<unknown>): Promise<ImportSourceError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ImportSourceError);
    return error as ImportSourceError;
  }
  throw new Error('失敗するはずが成功した');
}

function expectSafe(error: ImportSourceError, pat: string = PAT) {
  const text = `${error.message} ${String(error)}`;
  expect(error.message.length).toBeGreaterThan(0);
  expect(text).not.toContain(pat);
  expect(text).not.toContain('github_pat_');
  expect(text).not.toContain(FAKE_FAILURE_MARK);
  expect(text).not.toContain('api.github.com');
  expect(text).not.toContain('evil.example');
}

const badShapes: [string, string][] = [
  ['classic', 'ghp_0123456789abcdefABCDEF0123456789abcd'],
  ['空', ''],
  ['前に空白', ` ${PAT}`],
  ['後ろに空白', `${PAT} `],
  ['後ろに改行', `${PAT}\n`],
  ['途中に改行', `${PAT.slice(0, 20)}\n${PAT.slice(20)}`],
  ['短い（21文字）', `github_pat_${'a'.repeat(21)}`],
  ['長すぎる（256文字）', `github_pat_${'a'.repeat(256 - 11)}`],
  ['接頭辞だけ', 'github_pat_'],
  ['他の文字を含む', `github_pat_${'a'.repeat(21)}-`],
  ['日本語を含む', `github_pat_${'a'.repeat(21)}あ`],
  ['接頭辞の大文字', `GITHUB_PAT_${'a'.repeat(30)}`],
];

describe('完了条件: 形の合う PAT', () => {
  test('形の検査は問い合わせずに真偽を返す', () => {
    expect(source.isCredentialShape(PAT)).toBe(true);
    expect(source.isCredentialShape(`github_pat_${'a'.repeat(22)}`)).toBe(true);
    expect(source.isCredentialShape(`github_pat_${'A_9'.repeat(10)}`)).toBe(true);
  });

  test('全体で255文字までは通り、256文字は通らない', () => {
    expect(source.isCredentialShape(`github_pat_${'a'.repeat(255 - 11)}`)).toBe(true);
    expect(source.isCredentialShape(`github_pat_${'a'.repeat(256 - 11)}`)).toBe(false);
  });

  test('末尾4文字を返す', () => {
    expect(source.credentialLast4(PAT)).toBe(PAT.slice(-4));
    expect(source.credentialLast4(`github_pat_${'a'.repeat(18)}wxyz`)).toBe('wxyz');
  });

  test('有効な PAT で持ち主（個人）を返す', async () => {
    const fake = setup();
    await expect(source.verifyCredential(PAT, fake.fetcher)).resolves.toEqual({
      kind: 'user',
      id: '4242',
      name: 'fake-ranger',
    });
  });

  test('組織の持ち主は organization で返す', async () => {
    const fake = createFakePatGithub();
    fake.addAccount(PAT, { type: 'Organization', id: 77, login: 'fake-guild-org' });
    await expect(source.verifyCredential(PAT, fake.fetcher)).resolves.toEqual({
      kind: 'organization',
      id: '77',
      name: 'fake-guild-org',
    });
  });

  test('id は10進の文字列（大きい安全な整数も）', async () => {
    const fake = createFakePatGithub();
    fake.addAccount(PAT, { type: 'User', id: Number.MAX_SAFE_INTEGER, login: 'fake-big' });
    const owner = await source.verifyCredential(PAT, fake.fetcher);
    expect(owner.id).toBe('9007199254740991');
  });

  test('候補は id（文字列）と full_name を返す', async () => {
    const fake = setup([
      { id: 11, full_name: 'fake-ranger/alpha', private: true, extra: 'x' },
      { id: 12, full_name: 'fake-guild-org/beta.js' },
    ]);
    await expect(source.listScopeCandidates(PAT, fake.fetcher)).resolves.toEqual([
      { id: '11', name: 'fake-ranger/alpha' },
      { id: '12', name: 'fake-guild-org/beta.js' },
    ]);
  });
});

describe('完了条件: 頁をまたぐ候補', () => {
  test.each([0, 1, 99, 100, 101, 199, 200, 201, 250])('%i 件で漏れも重複も無い', async (count) => {
    const repos = fakeRepos(count);
    const fake = setup(repos);
    const result = await source.listScopeCandidates(PAT, fake.fetcher);
    expect(result.map((c) => c.id)).toEqual(repos.map((r) => String(r.id)));
    expect(result.map((c) => c.name)).toEqual(repos.map((r) => r.full_name));
    expect(new Set(result.map((c) => c.id)).size).toBe(count);
  });

  test.each([
    [0, 1],
    [99, 1],
    [100, 2],
    [101, 2],
    [200, 3],
    [201, 3],
  ])('%i 件は %i 回の問い合わせで終わる', async (count, requests) => {
    const fake = setup(fakeRepos(count));
    await source.listScopeCandidates(PAT, fake.fetcher);
    expect(fake.calls).toHaveLength(requests);
    fake.calls.forEach((call, i) => {
      const url = new URL(call.url);
      expect(url.origin + url.pathname).toBe(FAKE_PAT_REPOS_URL);
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('page')).toBe(String(i + 1));
    });
  });

  test('重複する id は1つにする（頁の間で動いた場合）', async () => {
    const repos = [...fakeRepos(100), { id: 1000, full_name: 'guild-fake/repo-1000' }, ...fakeRepos(2, 5000)];
    const fake = setup(repos);
    const result = await source.listScopeCandidates(PAT, fake.fetcher);
    expect(result.map((c) => c.id)).toEqual([...fakeRepos(100), ...fakeRepos(2, 5000)].map((r) => String(r.id)));
  });

  test('頁の上限（100頁）ちょうどまでは返す', async () => {
    const fake = setup(fakeRepos(9999));
    const result = await source.listScopeCandidates(PAT, fake.fetcher);
    expect(result).toHaveLength(9999);
    expect(fake.calls).toHaveLength(100);
  });
});

describe('断る場合: 頁の上限', () => {
  test('100頁を超えるなら unavailable', async () => {
    const fake = setup(fakeRepos(10001));
    const error = await failureOf(source.listScopeCandidates(PAT, fake.fetcher));
    expect(error.failure).toBe('unavailable');
    expectSafe(error);
    expect(fake.calls.length).toBeLessThanOrEqual(101);
  });
});

describe('断る場合: 形の違う PAT は GitHub に問い合わせない', () => {
  test.each(badShapes)('%s', async (_name, pat) => {
    expect(source.isCredentialShape(pat)).toBe(false);
    expect(() => source.credentialLast4(pat)).toThrow(ImportSourceError);
    try {
      source.credentialLast4(pat);
    } catch (error) {
      expect((error as ImportSourceError).failure).toBe('invalid_format');
      expect(String(error)).not.toContain(pat.trim() || 'x'.repeat(40));
    }

    const fake = setup();
    fake.addAccount(pat, OWNER, fakeRepos(2));
    const verify = await failureOf(source.verifyCredential(pat, fake.fetcher));
    const list = await failureOf(source.listScopeCandidates(pat, fake.fetcher));
    expect(verify.failure).toBe('invalid_format');
    expect(list.failure).toBe('invalid_format');
    expect(fake.calls).toHaveLength(0);
  });

  test('文字列でない値も形が合わない', () => {
    expect(source.isCredentialShape(undefined as unknown as string)).toBe(false);
    expect(source.isCredentialShape(null as unknown as string)).toBe(false);
    expect(source.isCredentialShape(1234 as unknown as string)).toBe(false);
  });
});

describe('断る場合: GitHub の失敗の区別', () => {
  const cases: [string, FakeFailure, ImportSourceFailure][] = [
    ['401', { kind: 'status', status: 401 }, 'unauthorized'],
    ['403', { kind: 'status', status: 403 }, 'forbidden'],
    ['429', { kind: 'status', status: 429 }, 'forbidden'],
    ['500', { kind: 'status', status: 500 }, 'unavailable'],
    ['502', { kind: 'status', status: 502 }, 'unavailable'],
    ['503', { kind: 'status', status: 503 }, 'unavailable'],
    ['ネットワーク例外', { kind: 'network' }, 'unavailable'],
    ['302', { kind: 'redirect' }, 'unavailable'],
    ['301', { kind: 'redirect', status: 301 }, 'unavailable'],
    ['307', { kind: 'redirect', status: 307 }, 'unavailable'],
    ['JSON でない', { kind: 'not-json' }, 'unavailable'],
  ];

  describe.each(cases)('%s', (_name, failure, expected) => {
    test('verifyCredential', async () => {
      const fake = setup();
      fake.failNext(failure);
      const error = await failureOf(source.verifyCredential(PAT, fake.fetcher));
      expect(error.failure).toBe(expected);
      expectSafe(error);
    });

    test('listScopeCandidates', async () => {
      const fake = setup();
      fake.failNext(failure);
      const error = await failureOf(source.listScopeCandidates(PAT, fake.fetcher));
      expect(error.failure).toBe(expected);
      expectSafe(error);
    });
  });

  test('PAT を GitHub が知らなければ unauthorized', async () => {
    const fake = createFakePatGithub();
    const error = await failureOf(source.verifyCredential(PAT, fake.fetcher));
    expect(error.failure).toBe('unauthorized');
    expectSafe(error);
  });

  test('例外のメッセージに PAT と目印が入っていても文に出ない', async () => {
    const fake = setup();
    fake.failNext({ kind: 'network', message: `fail ${PAT} ${FAKE_FAILURE_MARK}` });
    const error = await failureOf(source.verifyCredential(PAT, fake.fetcher));
    expect(error.failure).toBe('unavailable');
    expectSafe(error);
  });

  test('応答の本文に PAT と目印が入っていても文に出ない', async () => {
    for (const status of [401, 403, 429, 502]) {
      const fake = setup();
      fake.failNext({ kind: 'status', status, body: JSON.stringify({ message: `${PAT} ${FAKE_FAILURE_MARK}` }) });
      expectSafe(await failureOf(source.verifyCredential(PAT, fake.fetcher)));
    }
  });

  test('失敗の種類ごとに message が違い、固定である', async () => {
    const messages: string[] = [];
    for (const status of [401, 403, 502]) {
      const first = setup();
      first.failNext({ kind: 'status', status });
      const a = await failureOf(source.verifyCredential(PAT, first.fetcher));
      const second = setup();
      second.failNext({ kind: 'status', status, body: 'other body' });
      const b = await failureOf(source.verifyCredential(PAT, second.fetcher));
      expect(a.message).toBe(b.message);
      messages.push(a.message);
    }
    expect(new Set(messages).size).toBe(3);
  });

  test('別の PAT でも message は同じ（PAT に依らない）', async () => {
    const other = fakePat('Beta');
    const one = createFakePatGithub();
    one.failNext({ kind: 'status', status: 401 });
    const two = createFakePatGithub();
    two.failNext({ kind: 'status', status: 401 });
    const a = await failureOf(source.verifyCredential(PAT, one.fetcher));
    const b = await failureOf(source.verifyCredential(other, two.fetcher));
    expect(a.message).toBe(b.message);
    expectSafe(b, other);
  });
});

describe('断る場合: 応答の形の崩れ', () => {
  const brokenOwners: [string, unknown][] = [
    ['login が文字列でない', { type: 'User', id: 1, login: 5 }],
    ['login が無い', { type: 'User', id: 1 }],
    ['id が整数でない（文字列）', { type: 'User', id: '1', login: 'fake-a' }],
    ['id が小数', { type: 'User', id: 1.5, login: 'fake-a' }],
    ['id が 0', { type: 'User', id: 0, login: 'fake-a' }],
    ['id が負', { type: 'User', id: -3, login: 'fake-a' }],
    ['id が安全な整数を超える', { type: 'User', id: 2 ** 53, login: 'fake-a' }],
    ['id が無い', { type: 'User', login: 'fake-a' }],
    ['type が想定外（Bot）', { type: 'Bot', id: 1, login: 'fake-a' }],
    ['type が無い', { id: 1, login: 'fake-a' }],
    ['type が小文字', { type: 'user', id: 1, login: 'fake-a' }],
    ['null', null],
    ['配列', []],
    ['文字列', 'text'],
  ];

  test.each(brokenOwners)('持ち主: %s', async (_name, body) => {
    const fake = setup();
    fake.failNext({ kind: 'body', body });
    const error = await failureOf(source.verifyCredential(PAT, fake.fetcher));
    expect(error.failure).toBe('unavailable');
    expectSafe(error);
  });

  const brokenRepos: [string, unknown][] = [
    ['id が文字列', { id: '1', full_name: 'fake-a/b' }],
    ['id が小数', { id: 1.5, full_name: 'fake-a/b' }],
    ['id が無い', { full_name: 'fake-a/b' }],
    ['full_name が無い', { id: 1 }],
    ['full_name が数値', { id: 1, full_name: 5 }],
    ['full_name に / が無い', { id: 1, full_name: 'fake-a' }],
    ['full_name の owner が空', { id: 1, full_name: '/b' }],
    ['full_name の name が空', { id: 1, full_name: 'fake-a/' }],
    ['full_name の / が2つ', { id: 1, full_name: 'fake-a/b/c' }],
    ['null の要素', null],
    ['文字列の要素', 'fake-a/b'],
  ];

  test.each(brokenRepos)('候補: %s', async (_name, element) => {
    const fake = setup([{ id: 9, full_name: 'fake-a/ok' }, element]);
    const error = await failureOf(source.listScopeCandidates(PAT, fake.fetcher));
    expect(error.failure).toBe('unavailable');
    expectSafe(error);
  });

  test.each([
    ['オブジェクト', { id: 1, full_name: 'fake-a/b' }],
    ['null', null],
    ['文字列', 'text'],
  ])('候補: 応答が配列でない（%s）', async (_name, body) => {
    const fake = setup();
    fake.failNext({ kind: 'body', body });
    const error = await failureOf(source.listScopeCandidates(PAT, fake.fetcher));
    expect(error.failure).toBe('unavailable');
  });

  test('2頁目の要素が壊れていたら部分的な結果を返さずエラー', async () => {
    const repos: unknown[] = [...fakeRepos(100), { id: 'x', full_name: 'fake-a/b' }];
    const fake = setup(repos);
    const error = await failureOf(source.listScopeCandidates(PAT, fake.fetcher));
    expect(error.failure).toBe('unavailable');
  });
});

describe('断る場合: 途中の頁の失敗は部分的な結果を返さない', () => {
  const cases: [string, FakeFailure, ImportSourceFailure][] = [
    ['401', { kind: 'status', status: 401 }, 'unauthorized'],
    ['403', { kind: 'status', status: 403 }, 'forbidden'],
    ['429', { kind: 'status', status: 429 }, 'forbidden'],
    ['502', { kind: 'status', status: 502 }, 'unavailable'],
    ['ネットワーク例外', { kind: 'network' }, 'unavailable'],
    ['302', { kind: 'redirect' }, 'unavailable'],
    ['JSON でない', { kind: 'not-json' }, 'unavailable'],
  ];

  test.each(cases)('2頁目が %s', async (_name, failure, expected) => {
    const fake = setup(fakeRepos(250));
    fake.failOnPage(2, failure);
    const error = await failureOf(source.listScopeCandidates(PAT, fake.fetcher));
    expect(error.failure).toBe(expected);
    expectSafe(error);
  });

  test('3頁目が失敗しても同じ', async () => {
    const fake = setup(fakeRepos(250));
    fake.failOnPage(3, { kind: 'status', status: 502 });
    const error = await failureOf(source.listScopeCandidates(PAT, fake.fetcher));
    expect(error.failure).toBe('unavailable');
  });
});

describe('すり抜け: 送る内容', () => {
  test('verifyCredential のヘッダー、redirect、signal', async () => {
    const fake = setup();
    await source.verifyCredential(PAT, fake.fetcher);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(FAKE_PAT_USER_URL);
    expect(call.redirect).toBe('manual');
    expect(call.hasSignal).toBe(true);
    expect(call.headers['authorization']).toBe(`Bearer ${PAT}`);
    expect(call.headers['accept']).toBe('application/vnd.github+json');
    expect(call.headers['x-github-api-version']).toBe('2022-11-28');
    expect((call.headers['user-agent'] ?? '').length).toBeGreaterThan(0);
  });

  test('listScopeCandidates の各頁のヘッダー、redirect、signal', async () => {
    const fake = setup(fakeRepos(150));
    await source.listScopeCandidates(PAT, fake.fetcher);
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.method).toBe('GET');
      expect(call.url.startsWith(`${FAKE_PAT_REPOS_URL}?`)).toBe(true);
      expect(call.redirect).toBe('manual');
      expect(call.hasSignal).toBe(true);
      expect(call.headers['authorization']).toBe(`Bearer ${PAT}`);
      expect(call.headers['accept']).toBe('application/vnd.github+json');
      expect(call.headers['x-github-api-version']).toBe('2022-11-28');
    }
  });

  test('Authorization 以外に PAT が出ない（URL、他のヘッダー）', async () => {
    const fake = setup(fakeRepos(150));
    await source.verifyCredential(PAT, fake.fetcher);
    await source.listScopeCandidates(PAT, fake.fetcher);
    for (const call of fake.calls) {
      expect(call.url).not.toContain(PAT);
      expect(call.url).not.toContain('github_pat_');
      for (const [name, value] of Object.entries(call.headers)) {
        if (name === 'authorization') continue;
        expect(value).not.toContain(PAT);
      }
    }
  });

  test('通信先は固定の https://api.github.com だけ', async () => {
    const fake = setup(fakeRepos(150));
    await source.verifyCredential(PAT, fake.fetcher);
    await source.listScopeCandidates(PAT, fake.fetcher);
    for (const call of fake.calls) expect(new URL(call.url).origin).toBe('https://api.github.com');
  });

  test('3xx の Location へは追わない', async () => {
    const fake = setup();
    fake.failNext({ kind: 'redirect' });
    await failureOf(source.verifyCredential(PAT, fake.fetcher));
    expect(fake.calls).toHaveLength(1);
  });

  test('時間切れ（TimeoutError）は unavailable になる', async () => {
    const timedOut: typeof fetch = () =>
      Promise.reject(new DOMException(`timeout ${FAKE_FAILURE_MARK}`, 'TimeoutError'));
    const error = await failureOf(source.verifyCredential(PAT, timedOut));
    expect(error.failure).toBe('unavailable');
    expectSafe(error);
  });
});

describe('ランタイム: 種類の表と設定', () => {
  test('importSourceOf("github") は github の実装を返す', () => {
    const github = importSourceOf('github');
    expect(github.kind).toBe('github');
    expect(github.scopeKind).toBe('github_repo');
    expect(importSourceOf('github')).toBe(github);
  });

  test('isImportSourceKind', () => {
    expect(isImportSourceKind('github')).toBe(true);
    for (const value of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'GitHub',
      'gitlab',
      '',
      1,
      0,
      null,
      undefined,
      {},
      [],
    ])
      expect(isImportSourceKind(value)).toBe(false);
  });

  test('parseSettings は undefined と {} だけ受けて {} を返す', () => {
    expect(source.parseSettings(undefined)).toEqual({});
    expect(source.parseSettings({})).toEqual({});
  });

  test.each([
    ['null', null],
    ['配列', []],
    ['要素のある配列', [{}]],
    ['文字列', '{}'],
    ['数値', 0],
    ['真偽値', false],
    ['キーのあるオブジェクト', { repo: 'x' }],
    ['値が undefined のキー', { a: undefined }],
    ['__proto__ のキー', JSON.parse('{"__proto__": {}}') as unknown],
  ])('parseSettings は %s を断る', (_name, value) => {
    expect(source.parseSettings(value)).toBeNull();
  });
});
