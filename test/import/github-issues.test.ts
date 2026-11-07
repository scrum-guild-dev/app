// GitHub の取り込み元の、担当の Issue の取得と変換（fetchPage）。偽物の GitHub に fetcher を差し、実装を直に呼ぶ
import { describe, expect, test } from 'vitest';
import { ImportSourceError, importSourceOf } from '../../src/server/import/index.ts';
import type { ImportItem, ImportSourceFailure, ScopeCandidate } from '../../src/server/import/index.ts';
import { FAKE_FAILURE_MARK, createFakePatGithub, fakeIssue, fakePat } from './fake-github-pat.ts';

const source = importSourceOf('github');
const PAT = fakePat('Gamma');
const OWNER = { type: 'User', id: 4242, login: 'fake-ranger' };
const REPO_A: ScopeCandidate = { id: '1001', name: 'guild-fake/alpha' };
const REPO_B: ScopeCandidate = { id: '1002', name: 'guild-fake/beta' };

function setup() {
  const fake = createFakePatGithub();
  fake.addAccount(PAT, OWNER);
  return fake;
}

type Input = { scope?: ScopeCandidate; cursor?: string | null; settings?: Record<string, unknown> };

function page(fake: ReturnType<typeof setup>, input: Input = {}, credential = PAT) {
  return source.fetchPage({
    credential,
    fetcher: fake.fetcher,
    settings: input.settings ?? {},
    scope: input.scope ?? REPO_A,
    cursor: input.cursor ?? null,
  });
}

// 続きの位置が無くなるまで取り、取った項目と頁数を返す
async function drain(fake: ReturnType<typeof setup>, input: Input = {}, limit = 30) {
  const items: ImportItem[] = [];
  let cursor: string | null = input.cursor ?? null;
  let pages = 0;
  do {
    const result = await page(fake, { ...input, cursor });
    items.push(...result.items);
    cursor = result.next;
    pages++;
  } while (cursor !== null && pages < limit);
  return { items, pages, done: cursor === null };
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

describe('完了条件: 担当者が自分の未完了の Issue だけ', () => {
  const mixed = () => [
    fakeIssue(REPO_A.name, 1),
    fakeIssue(REPO_A.name, 2, { state: 'closed' }),
    fakeIssue(REPO_A.name, 3, { assignees: ['fake-other'] }),
    fakeIssue(REPO_A.name, 4, { pr: true }),
    fakeIssue(REPO_A.name, 5, { assignees: ['fake-other', 'fake-ranger'] }),
  ];

  test('閉じた Issue、他人の担当、PR は返らない', async () => {
    const fake = setup();
    fake.addIssues(1001, mixed());
    const { items, next } = await page(fake);
    expect(items.map((i) => i.key)).toEqual(['guild-fake/alpha#1', 'guild-fake/alpha#5']);
    expect(next).toBeNull();
  });

  test('絞り込みを無視する応答でも、実装側で同じに絞る', async () => {
    const fake = setup();
    fake.addIssues(1001, mixed());
    fake.ignoreIssueFilters();
    const { items } = await page(fake);
    expect(items.map((i) => i.key)).toEqual(['guild-fake/alpha#1', 'guild-fake/alpha#5']);
  });

  test('範囲のリポジトリだけを問い合わせる', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1)]);
    fake.addIssues(1002, [fakeIssue(REPO_B.name, 2)]);
    const { items } = await page(fake, { scope: REPO_B });
    expect(items.map((i) => i.containerId)).toEqual(['1002']);
    expect(fake.calls.filter((c) => c.url.includes('/repositories/')).every((c) => c.url.includes('/1002/'))).toBe(
      true,
    );
  });

  test('ログイン名の大文字小文字は区別しない', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1, { assignees: ['Fake-Ranger'] })]);
    fake.ignoreIssueFilters();
    const { items } = await page(fake);
    expect(items).toHaveLength(1);
  });

  test('取り込み元を問わない形に変換する', async () => {
    const fake = setup();
    fake.addIssues(1001, [
      fakeIssue(REPO_A.name, 7, { id: 9_000_000_007, number: 42, dueOn: '2026-03-01T00:00:00Z', title: '架空の題' }),
    ]);
    const { items } = await page(fake);
    expect(items).toEqual([
      {
        kind: 'issue',
        sourceId: '9000000007',
        reviewerSourceId: '',
        key: 'guild-fake/alpha#42',
        url: 'https://github.com/guild-fake/alpha/issues/42',
        title: '架空の題',
        containerId: '1001',
        containerName: 'guild-fake/alpha',
        status: 'open',
        dueOn: '2026-03-01',
        updatedAt: '2026-01-01T00:07:00.000Z',
        isDone: false,
      },
    ]);
  });

  test('期限が無ければ null', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1)]);
    const { items } = await page(fake);
    expect(items[0]?.dueOn).toBeNull();
  });
});

describe('完了条件: 不変の ID', () => {
  test('sourceId は GitHub の ID で、番号ではない', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1, { id: 777_001, number: 3 })]);
    const { items } = await page(fake);
    expect(items[0]?.sourceId).toBe('777001');
    expect(items[0]?.key).toBe('guild-fake/alpha#3');
  });

  test('リポジトリの ID で呼ぶ（改名しても同じ）', async () => {
    const fake = setup();
    fake.addIssues(1001, []);
    await page(fake);
    const url = new URL(fake.calls.find((c) => c.url.includes('/repositories/'))!.url);
    expect(url.pathname).toBe('/repositories/1001/issues');
    expect(url.searchParams.get('assignee')).toBe('fake-ranger');
    expect(url.searchParams.get('state')).toBe('open');
    expect(url.searchParams.get('sort')).toBe('updated');
    expect(url.searchParams.get('direction')).toBe('asc');
  });
});

describe('完了条件: 「自分」', () => {
  test('設定に login が無ければ、最初の頁で GET /user から読み、続きの頁では問い合わせ直さない', async () => {
    const fake = setup();
    fake.addIssues(
      1001,
      Array.from({ length: 150 }, (_, i) => fakeIssue(REPO_A.name, i + 1)),
    );
    const first = await page(fake);
    expect(first.next).not.toBeNull();
    await page(fake, { cursor: first.next });
    expect(fake.calls.filter((c) => c.url === 'https://api.github.com/user')).toHaveLength(1);
  });

  test('設定に login があれば GET /user を呼ばない', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1)]);
    const { items } = await page(fake, { settings: { login: 'fake-ranger' } });
    expect(items).toHaveLength(1);
    expect(fake.calls.some((c) => c.url === 'https://api.github.com/user')).toBe(false);
  });
});

describe('完了条件: 頁と続きの位置', () => {
  const many = (count: number, repo = REPO_A) => Array.from({ length: count }, (_, i) => fakeIssue(repo.name, i + 1));

  test.each([0, 1, 99, 100, 101, 250])('%i 件は頁をまたいでも漏れず、1頁の中に重なりが無い', async (count) => {
    const fake = setup();
    fake.addIssues(1001, many(count));
    const { items, done } = await drain(fake);
    expect(done).toBe(true);
    expect(new Set(items.map((i) => i.sourceId))).toEqual(new Set(many(count).map((i) => String(i.id))));
  });

  test('1頁は1回の問い合わせ（最初の頁だけ GET /user が加わる）', async () => {
    const fake = setup();
    fake.addIssues(1001, many(3));
    await page(fake);
    expect(fake.calls).toHaveLength(2);
  });

  test('取得の間に先頭の Issue が更新されても、漏れない（重複は許す）', async () => {
    const fake = setup();
    fake.addIssues(1001, many(250));
    const first = await page(fake);
    expect(first.next).not.toBeNull();
    // 1件目にコメントが付き、更新日時が最新になって末尾へ動く
    fake.addIssues(
      1001,
      many(250).map((issue) => (issue.number === 1 ? { ...issue, updated_at: '2026-06-01T00:00:00.000Z' } : issue)),
    );
    const rest = await drain(fake, { cursor: first.next });
    const seen = new Set([...first.items, ...rest.items].map((i) => i.sourceId));
    expect(rest.done).toBe(true);
    expect(seen.size).toBe(250);
  });

  test('同じ更新日時が1頁を超えて続いても、先へ進んで漏れない', async () => {
    const fake = setup();
    fake.addIssues(
      1001,
      Array.from({ length: 230 }, (_, i) => fakeIssue(REPO_A.name, i + 1, { updatedAt: '2026-02-02T00:00:00.000Z' })),
    );
    const { items, done } = await drain(fake);
    expect(done).toBe(true);
    expect(new Set(items.map((i) => i.sourceId)).size).toBe(230);
  });

  test.each([
    ['境界を含む', false],
    ['境界を含まない', true],
  ])('since が%s GitHub でも、ミリ秒なしの updated_at と同じ秒の並びで漏れない', async (_name, exclusive) => {
    const fake = setup();
    if (exclusive) fake.exclusiveIssueSince();
    // 本物の GitHub の updated_at はミリ秒なし。先頭の 150 件が同じ秒で、1頁の境目をまたぐ
    fake.addIssues(
      1001,
      Array.from({ length: 250 }, (_, i) =>
        fakeIssue(REPO_A.name, i + 1, {
          updatedAt: i < 150 ? '2026-03-01T00:00:05Z' : `2026-03-01T00:10:${String(i % 60).padStart(2, '0')}Z`,
        }),
      ),
    );
    const { items, done } = await drain(fake);
    expect(done).toBe(true);
    expect(new Set(items.map((i) => i.sourceId)).size).toBe(250);
  });

  test('続きの位置は同じ位置を返さない（同期の仕組みが進まないと断るため）', async () => {
    const fake = setup();
    fake.addIssues(
      1001,
      Array.from({ length: 230 }, (_, i) => fakeIssue(REPO_A.name, i + 1, { updatedAt: '2026-02-02T00:00:00.000Z' })),
    );
    const seen = new Set<string | null>([null]);
    let cursor: string | null = null;
    do {
      const result = await page(fake, { cursor });
      if (result.next !== null) {
        expect(seen.has(result.next)).toBe(false);
        seen.add(result.next);
      }
      cursor = result.next;
    } while (cursor !== null);
  });

  test('続きの位置が壊れていれば断る', async () => {
    const fake = setup();
    await expect(page(fake, { cursor: 'x' })).rejects.toThrow(TypeError);
    await expect(page(fake, { cursor: 'fake-ranger:0:' })).rejects.toThrow(TypeError);
    await expect(page(fake, { cursor: 'fake-ranger:1:きのう' })).rejects.toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
  });

  test('範囲の ID と名前が不正なら問い合わせずに断る', async () => {
    const fake = setup();
    await expect(page(fake, { scope: { id: '0', name: 'guild-fake/alpha' } })).rejects.toThrow(TypeError);
    await expect(page(fake, { scope: { id: '1', name: 'alpha' } })).rejects.toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('完了条件: 失敗の区別', () => {
  const cases: [string, number, ImportSourceFailure][] = [
    ['401', 401, 'unauthorized'],
    ['403', 403, 'forbidden'],
    ['429', 429, 'forbidden'],
    ['500', 500, 'unavailable'],
    ['502', 502, 'unavailable'],
    ['503', 503, 'unavailable'],
  ];

  test.each(cases)('%s は %s', async (_name, status, failure) => {
    const fake = setup();
    fake.addIssues(1001, []);
    const settings = { login: 'fake-ranger' };
    fake.failNext({ kind: 'status', status });
    const error = await failureOf(page(fake, { settings }));
    expect(error.failure).toBe(failure);
    expect(error.message).not.toContain(FAKE_FAILURE_MARK);
    expect(error.message).not.toContain(PAT);
  });

  test('GET /user の失敗も区別できる', async () => {
    const fake = setup();
    fake.failNext({ kind: 'status', status: 401 });
    const error = await failureOf(page(fake));
    expect(error.failure).toBe('unauthorized');
  });

  test('2頁目の失敗でも区別できる', async () => {
    const fake = setup();
    fake.addIssues(
      1001,
      Array.from({ length: 150 }, (_, i) => fakeIssue(REPO_A.name, i + 1, { updatedAt: '2026-02-02T00:00:00.000Z' })),
    );
    // 同じ秒が続くので、起点を変えずに頁番号が進む（2頁目は2回目の取り直しの中）
    const first = await page(fake);
    const second = await page(fake, { cursor: first.next });
    fake.failOnIssuePage(2, { kind: 'status', status: 403 });
    const error = await failureOf(page(fake, { cursor: second.next }));
    expect(error.failure).toBe('forbidden');
  });

  test.each([
    ['届かない', { kind: 'network' }],
    ['JSON でない', { kind: 'not-json' }],
    ['リダイレクト', { kind: 'redirect' }],
    ['配列でない', { kind: 'body', body: { message: 'x' } }],
    ['要素が壊れている', { kind: 'body', body: [1] }],
    ['id が無い', { kind: 'body', body: [{ number: 1, state: 'open', assignees: [{ login: 'fake-ranger' }] }] }],
  ] as const)('%s は unavailable', async (_name, failure) => {
    const fake = setup();
    fake.failNext(failure);
    const error = await failureOf(page(fake, { settings: { login: 'fake-ranger' } }));
    expect(error.failure).toBe('unavailable');
  });

  test('PAT の形が合わなければ問い合わせずに invalid_format', async () => {
    const fake = setup();
    const error = await failureOf(page(fake, {}, 'ghp_x'));
    expect(error.failure).toBe('invalid_format');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('応答の検証', () => {
  test.each([
    ['題が空', { title: '' }],
    ['題が長すぎる', { title: 'あ'.repeat(257) }],
    ['URL が別のホスト', { html_url: 'https://github.com.evil.example/guild-fake/alpha/issues/1' }],
    ['URL が http', { html_url: 'http://github.com/guild-fake/alpha/issues/1' }],
    ['URL が Issue の形でない', { html_url: 'https://github.com/guild-fake/alpha/pull/1' }],
    ['URL にクエリ', { html_url: 'https://github.com/guild-fake/alpha/issues/1?x=1' }],
    ['updated_at が不正', { updated_at: 'きのう' }],
    ['期限が不正', { milestone: { due_on: 'あした' } }],
  ])('%s は unavailable', async (_name, patch) => {
    const fake = setup();
    fake.addIssues(1001, [{ ...fakeIssue(REPO_A.name, 1), ...patch }]);
    const error = await failureOf(page(fake, { settings: { login: 'fake-ranger' } }));
    expect(error.failure).toBe('unavailable');
  });

  test('題の上限は文字数（コードポイント）で数える', async () => {
    const fake = setup();
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1, { title: '😀'.repeat(256) })]);
    const { items } = await page(fake);
    expect(items).toHaveLength(1);
    fake.addIssues(1001, [fakeIssue(REPO_A.name, 1, { title: '😀'.repeat(257) })]);
    const error = await failureOf(page(fake));
    expect(error.failure).toBe('unavailable');
  });

  test('URL の番号と応答の番号が食い違う応答は断る。URL は検証した部品から組み直す', async () => {
    const fake = setup();
    fake.addIssues(1001, [
      { ...fakeIssue(REPO_A.name, 1, { number: 3 }), html_url: 'https://github.com/guild-fake/alpha/issues/4' },
    ]);
    const error = await failureOf(page(fake));
    expect(error.failure).toBe('unavailable');
    fake.addIssues(1001, [
      { ...fakeIssue(REPO_A.name, 1, { number: 3 }), html_url: 'https://user:pw@github.com/guild-fake/alpha/issues/3' },
    ]);
    const { items } = await page(fake);
    expect(items[0]?.url).toBe('https://github.com/guild-fake/alpha/issues/3');
  });

  test('キーは応答の URL の今のリポジトリ名から作る（改名後も食い違わない）', async () => {
    const fake = setup();
    fake.addIssues(1001, [
      {
        ...fakeIssue(REPO_A.name, 1, { number: 9 }),
        html_url: 'https://github.com/guild-fake/alpha-renamed/issues/9',
      },
    ]);
    const { items } = await page(fake);
    expect(items[0]?.key).toBe('guild-fake/alpha-renamed#9');
    expect(items[0]?.containerId).toBe('1001');
  });
});

describe('通信の作法', () => {
  test('固定のホスト、Bearer、redirect: manual、時間切れ付き', async () => {
    const fake = setup();
    fake.addIssues(1001, []);
    await page(fake);
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(new URL(call.url).origin).toBe('https://api.github.com');
      expect(call.headers['authorization']).toBe(`Bearer ${PAT}`);
      expect(call.redirect).toBe('manual');
      expect(call.hasSignal).toBe(true);
    }
  });
});
