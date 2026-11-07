// 範囲の候補の一覧の全体の期限（頁を始める前に判定する）と、名前の形に合わない行の扱い
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ImportSourceError, importSourceOf } from '../../src/server/import/index.ts';
import { fakePat, fakeRepos } from './fake-github-pat.ts';

const source = importSourceOf('github');
const PAT = fakePat('Deadline');

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('一覧の全体の期限', () => {
  test('期限を過ぎたら次の頁を取りに行かず unavailable', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      urls.push(String(input));
      now += 61_000;
      return json(fakeRepos(100, urls.length * 100));
    };
    const error = await source.listScopeCandidates(PAT, fetcher).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportSourceError);
    expect((error as ImportSourceError).failure).toBe('unavailable');
    expect(urls).toHaveLength(1);
  });

  test('期限の内なら最後の頁まで返す', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      now += 10_000;
      return json(calls < 3 ? fakeRepos(100, calls * 100) : fakeRepos(5, calls * 100));
    };
    expect(await source.listScopeCandidates(PAT, fetcher)).toHaveLength(205);
  });
});

describe('名前の形に合わない行', () => {
  test.each([
    'a/b/c',
    'owner/',
    '/name',
    'own er/name',
    'owner/na\nme',
    'o‮wner/name',
    `${'a'.repeat(81)}/n`,
    `o/${'n'.repeat(101)}`,
  ])('%j が1件でもあれば全体が unavailable（その行だけ捨てない）', async (fullName) => {
    const fetcher: typeof fetch = async () => json([...fakeRepos(2, 0), { id: 999_999, full_name: fullName }]);
    const error = await source.listScopeCandidates(PAT, fetcher).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportSourceError);
    expect((error as ImportSourceError).failure).toBe('unavailable');
  });
});
