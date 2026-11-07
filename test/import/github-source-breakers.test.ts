// GitHub の取り込み元を崩す入力。github-source.test.ts と重ならない手口だけを置く
import { describe, expect, test } from 'vitest';
import { ImportSourceError, importSourceOf } from '../../src/server/import/index.ts';
import { fakePat, fakeRepos } from './fake-github-pat.ts';

const source = importSourceOf('github');
const PAT = fakePat('Breaker');
const SECRET = 'SECRET-BREAKER-77';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Fetcher = typeof fetch;

function counting(handler: (url: string, n: number) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetcher: Fetcher = async (input) => {
    const url = String(input);
    urls.push(url);
    return handler(url, urls.length);
  };
  return { fetcher, urls };
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

function everyText(error: Error): string {
  return [
    error.message,
    String(error),
    error.stack ?? '',
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyNames(error).map((k) => [k, String((error as never)[k])])),
  ].join('\n');
}

describe('形の検査: 文字種と境界', () => {
  const bad: [string, string][] = [
    ['全角の英数字', `github_pat_${'ａ'.repeat(22)}`],
    ['絵文字（サロゲート対）', `github_pat_${'😀'.repeat(11)}`],
    ['$ を含む', `github_pat_${'a'.repeat(21)}$`],
    ['ドットを含む', `github_pat_${'a'.repeat(21)}.`],
    ['NUL を含む', `github_pat_${'a'.repeat(21)}\u0000`],
    ['タブを含む', `github_pat_${'a'.repeat(21)}\t`],
    ['行区切り U+2028 を後ろに', `github_pat_${'a'.repeat(22)}\u2028`],
    ['BOM を前に', `\uFEFFgithub_pat_${'a'.repeat(22)}`],
    ['接頭辞の混在大小文字', `Github_pat_${'a'.repeat(22)}`],
    ['接頭辞の _ が -', `github-pat_${'a'.repeat(22)}`],
    ['接頭辞が2回で長すぎ', `github_pat_github_pat_${'a'.repeat(240)}`],
    ['トルコ語の dotless i', `github_pat_${'ı'.repeat(22)}`],
    ['null 文字列', 'null'],
  ];

  test.each(bad)('%s は形が合わず、問い合わせない', async (_name, pat) => {
    expect(source.isCredentialShape(pat)).toBe(false);
    const { fetcher, urls } = counting(() => json({}));
    expect((await failureOf(source.verifyCredential(pat, fetcher))).failure).toBe('invalid_format');
    expect((await failureOf(source.listScopeCandidates(pat, fetcher))).failure).toBe('invalid_format');
    expect(() => source.credentialLast4(pat)).toThrow(ImportSourceError);
    expect(urls).toHaveLength(0);
  });

  test('文字列でない値を verify と list に渡しても問い合わせない', async () => {
    const { fetcher, urls } = counting(() => json({}));
    for (const value of [undefined, null, 5, {}, [PAT], new String(PAT), Symbol('x')]) {
      const v = value as unknown as string;
      expect((await failureOf(source.verifyCredential(v, fetcher))).failure).toBe('invalid_format');
      expect((await failureOf(source.listScopeCandidates(v, fetcher))).failure).toBe('invalid_format');
    }
    expect(urls).toHaveLength(0);
  });

  test('下限ちょうど（接頭辞 + 22 文字）と上限ちょうど（244 文字）は通り、末尾4文字が取れる', () => {
    expect(source.isCredentialShape(`github_pat_${'_'.repeat(22)}`)).toBe(true);
    expect(source.isCredentialShape(`github_pat_${'Z'.repeat(244)}`)).toBe(true);
    expect(source.isCredentialShape(`github_pat_${'Z'.repeat(245)}`)).toBe(false);
    expect(source.credentialLast4(`github_pat_${'a'.repeat(18)}____`)).toBe('____');
    expect(source.credentialLast4(`github_pat_${'a'.repeat(18)}`.concat('9Z_a'))).toBe('9Z_a');
    expect(source.credentialLast4(`github_pat_${'a'.repeat(18)}9Z_a`)).toHaveLength(4);
  });

  test('形の違いのエラーに cause が付かず、PAT 風の入力が文にもスタックにも出ない', () => {
    const bad = `github_pat_${SECRET}\n`;
    try {
      source.credentialLast4(bad);
      throw new Error('投げるはず');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportSourceError);
      expect('cause' in (error as object)).toBe(false);
      expect(everyText(error as Error)).not.toContain(SECRET);
    }
  });
});

describe('エラーの安全性: 例外から PAT が漏れない', () => {
  test('fetcher が cause に PAT を持つ例外を投げても、ImportSourceError に cause が付かない', async () => {
    const leaky: Fetcher = () => {
      throw new Error(`boom ${PAT}`, { cause: new Error(`inner ${PAT} ${SECRET}`) });
    };
    for (const run of [() => source.verifyCredential(PAT, leaky), () => source.listScopeCandidates(PAT, leaky)]) {
      const error = await failureOf(run());
      expect(error.failure).toBe('unavailable');
      expect(error.cause).toBeUndefined();
      expect('cause' in error).toBe(false);
      const text = everyText(error);
      expect(text).not.toContain(PAT);
      expect(text).not.toContain(SECRET);
      expect(Object.keys(error).sort()).toEqual(['failure', 'name']);
    }
  });

  test('文字列や undefined を reject する fetcher でも unavailable', async () => {
    for (const reason of [`${PAT} ${SECRET}`, undefined, null, { message: PAT }]) {
      const error = await failureOf(source.verifyCredential(PAT, () => Promise.reject(reason)));
      expect(error.failure).toBe('unavailable');
      expect(everyText(error)).not.toContain(PAT);
    }
  });

  test('本文の途中で壊れる 200（json() が遅れて失敗）は unavailable で、原因の PAT は出ない', async () => {
    const broken: Fetcher = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id": 1, "lo'));
          controller.error(new Error(`stream ${PAT} ${SECRET}`));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    for (const run of [() => source.verifyCredential(PAT, broken), () => source.listScopeCandidates(PAT, broken)]) {
      const error = await failureOf(run());
      expect(error.failure).toBe('unavailable');
      expect(everyText(error)).not.toContain(SECRET);
      expect(everyText(error)).not.toContain(PAT);
    }
  });

  test('本文の破棄（cancel）が失敗する 401/403/502 でも区別が保たれる', async () => {
    const withBadCancel =
      (status: number): Fetcher =>
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`bad ${SECRET}`));
            },
            cancel() {
              throw new Error(`cancel ${PAT}`);
            },
          }),
          { status },
        );
    expect((await failureOf(source.verifyCredential(PAT, withBadCancel(401)))).failure).toBe('unauthorized');
    expect((await failureOf(source.verifyCredential(PAT, withBadCancel(403)))).failure).toBe('forbidden');
    expect((await failureOf(source.verifyCredential(PAT, withBadCancel(502)))).failure).toBe('unavailable');
  });
});

describe('状態コードと本文の区別', () => {
  test.each([
    [204, 'unavailable'],
    [205, 'unavailable'],
    [304, 'unavailable'],
    [400, 'unavailable'],
    [404, 'unavailable'],
    [410, 'unavailable'],
    [422, 'unavailable'],
    [451, 'unavailable'],
    [500, 'unavailable'],
    [504, 'unavailable'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'forbidden'],
  ] as const)('%i は %s', async (status, expected) => {
    const body = status === 204 || status === 205 || status === 304 ? null : JSON.stringify({ message: SECRET });
    const fetcher: Fetcher = async () => new Response(body, { status });
    const owner = await failureOf(source.verifyCredential(PAT, fetcher));
    const list = await failureOf(source.listScopeCandidates(PAT, fetcher));
    expect(owner.failure).toBe(expected);
    expect(list.failure).toBe(expected);
    expect(everyText(owner)).not.toContain(SECRET);
  });

  test('200 で本文が空・空白・JSON の断片なら unavailable', async () => {
    for (const text of ['', ' ', '{', '[', 'undefined', 'NaN', '{"id":1,}']) {
      const fetcher: Fetcher = async () => new Response(text, { status: 200 });
      expect((await failureOf(source.verifyCredential(PAT, fetcher))).failure).toBe('unavailable');
      expect((await failureOf(source.listScopeCandidates(PAT, fetcher))).failure).toBe('unavailable');
    }
  });

  test('redirect: manual の本物の応答（opaqueredirect, status 0, ok 偽）は unavailable', async () => {
    const opaque = { ok: false, status: 0, type: 'opaqueredirect', body: null, json: () => Promise.resolve({}) };
    const fetcher: Fetcher = async () => opaque as unknown as Response;
    expect((await failureOf(source.verifyCredential(PAT, fetcher))).failure).toBe('unavailable');
  });
});

describe('持ち主の応答の崩れ', () => {
  const owner = (over: Record<string, unknown>) => ({ type: 'User', id: 5, login: 'fake-a', ...over });
  const broken: [string, unknown][] = [
    ['id が -0', owner({ id: -0 })],
    ['id が真偽値', owner({ id: true })],
    ['id が配列', owner({ id: [5] })],
    ['id が null', owner({ id: null })],
    ['id が 1e21', owner({ id: 1e21 })],
    ['id が Infinity 相当（1e999）', JSON.parse('{"type":"User","id":1e999,"login":"fake-a"}') as unknown],
    ['login が空', owner({ login: '' })],
    ['login が 81 文字', owner({ login: 'a'.repeat(81) })],
    ['login が先頭ハイフン', owner({ login: '-fake' })],
    ['login に空白', owner({ login: 'fake a' })],
    ['login に末尾の改行', owner({ login: 'fake-a\n' })],
    ['login に /', owner({ login: 'fake/a' })],
    ['login に全角', owner({ login: 'ｆａｋｅ' })],
    ['login が __proto__', owner({ login: '__proto__' })],
    ['login が配列', owner({ login: ['fake-a'] })],
    ['login が [bot]', owner({ login: 'fake[bot]' })],
    ['type が "User " （空白付き）', owner({ type: 'User ' })],
    ['type が Enterprise', owner({ type: 'Enterprise' })],
    ['type が配列', owner({ type: ['User'] })],
    ['__proto__ だけの本文', JSON.parse('{"__proto__": {"id": 1, "login": "fake-a", "type": "User"}}') as unknown],
  ];

  test.each(broken)('%s', async (_name, body) => {
    const error = await failureOf(source.verifyCredential(PAT, async () => json(body)));
    expect(error.failure).toBe('unavailable');
  });

  test('余計なフィールドと入れ子は無視して持ち主を返す', async () => {
    const result = await source.verifyCredential(PAT, async () =>
      json(owner({ email: 'x@example.invalid', plan: { name: 'free' }, id: 9 })),
    );
    expect(result).toEqual({ kind: 'user', id: '9', name: 'fake-a' });
    expect(Object.keys(result).sort()).toEqual(['id', 'kind', 'name']);
  });
});

describe('候補の応答の崩れ', () => {
  const broken: [string, unknown][] = [
    ['full_name に空白', { id: 1, full_name: 'fake a/b' }],
    ['full_name の途中に改行', { id: 1, full_name: 'fake-a/b\nc' }],
    ['full_name の末尾に改行', { id: 1, full_name: 'fake-a/b\n' }],
    ['full_name の先頭に空白', { id: 1, full_name: ' fake-a/b' }],
    ['full_name の // ', { id: 1, full_name: 'fake-a//b' }],
    ['full_name の先頭 /', { id: 1, full_name: '/fake-a/b' }],
    ['full_name の末尾 /', { id: 1, full_name: 'fake-a/b/' }],
    ['full_name がノーブレークスペースを含む', { id: 1, full_name: 'fake-a/b\u00a0c' }],
    ['full_name が空', { id: 1, full_name: '' }],
    ['full_name が / だけ', { id: 1, full_name: '/' }],
    ['full_name が配列', { id: 1, full_name: ['a/b'] }],
    ['id が -0', { id: -0, full_name: 'fake-a/b' }],
    ['id が 2^53', { id: 2 ** 53, full_name: 'fake-a/b' }],
    ['id が null', { id: null, full_name: 'fake-a/b' }],
    ['要素が配列', ['fake-a/b']],
    ['要素が数値', 7],
    ['要素が真偽値', true],
  ];

  test.each(broken)('%s', async (_name, element) => {
    const error = await failureOf(source.listScopeCandidates(PAT, async () => json([element])));
    expect(error.failure).toBe('unavailable');
  });

  test('壊れた要素が最終頁の末尾にあっても、集めた分を返さない', async () => {
    const { fetcher } = counting((_url, n) => json(n === 1 ? fakeRepos(100) : [...fakeRepos(3, 9000), null]));
    expect((await failureOf(source.listScopeCandidates(PAT, fetcher))).failure).toBe('unavailable');
  });

  test('名前に使える記号（ドット、ハイフン、アンダースコア）はそのまま返す', async () => {
    const result = await source.listScopeCandidates(PAT, async () =>
      json([{ id: 3, full_name: 'fake-org_1/repo.name-v2_x' }]),
    );
    expect(result).toEqual([{ id: '3', name: 'fake-org_1/repo.name-v2_x' }]);
  });
});

describe('頁送りの崩し', () => {
  test('満杯の頁の中に重複があっても（一意が100未満）、次の頁へ進む', async () => {
    const page1 = [...fakeRepos(99), { id: 1000, full_name: 'guild-fake/repo-1000' }];
    const { fetcher, urls } = counting((_url, n) => json(n === 1 ? page1 : n === 2 ? fakeRepos(5, 7000) : []));
    const result = await source.listScopeCandidates(PAT, fetcher);
    expect(result).toHaveLength(99 + 5);
    expect(urls).toHaveLength(2);
  });

  test('頁をまたぐ重複は最初の名前を残し、順序を保つ', async () => {
    const { fetcher } = counting((_url, n) =>
      json(n === 1 ? fakeRepos(100) : [{ id: 1000, full_name: 'guild-fake/renamed' }, ...fakeRepos(1, 8000)]),
    );
    const result = await source.listScopeCandidates(PAT, fetcher);
    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({ id: '1000', name: 'guild-fake/repo-1000' });
    expect(result[100]).toEqual({ id: '8000', name: 'guild-fake/repo-8000' });
  });

  test('100件ちょうどの頁のあとが空頁なら、2回で終わり重複も欠けも無い', async () => {
    const { fetcher, urls } = counting((_url, n) => json(n === 1 ? fakeRepos(100) : []));
    const result = await source.listScopeCandidates(PAT, fetcher);
    expect(result).toHaveLength(100);
    expect(urls).toHaveLength(2);
  });

  test('空頁が最初の頁なら空配列', async () => {
    const { fetcher, urls } = counting(() => json([]));
    await expect(source.listScopeCandidates(PAT, fetcher)).resolves.toEqual([]);
    expect(urls).toHaveLength(1);
  });

  test('全頁が同じ100件の重複を返し続ける応答でも、止まって unavailable にする', async () => {
    const { fetcher, urls } = counting(() => json(fakeRepos(100)));
    const error = await failureOf(source.listScopeCandidates(PAT, fetcher));
    expect(error.failure).toBe('unavailable');
    expect(urls.length).toBeLessThanOrEqual(101);
  });

  test('ちょうど10000件（100頁目まで満杯で、101頁目が空）は返す', async () => {
    // 実装の注釈は「超える（100頁目まで満杯で続く）ときは断る」。続かない10000件ちょうどは断る理由が無い
    const all = fakeRepos(10000);
    const { fetcher } = counting((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return json(all.slice((page - 1) * 100, page * 100));
    });
    const result = await source.listScopeCandidates(PAT, fetcher);
    expect(result).toHaveLength(10000);
  });

  test('各頁の URL は page=1.. の昇順で、パラメータは per_page と page だけ', async () => {
    const all = fakeRepos(230);
    const { fetcher, urls } = counting((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return json(all.slice((page - 1) * 100, page * 100));
    });
    await source.listScopeCandidates(PAT, fetcher);
    expect(urls.map((u) => [...new URL(u).searchParams.keys()])).toEqual([
      ['per_page', 'page'],
      ['per_page', 'page'],
      ['per_page', 'page'],
    ]);
  });
});

describe('送る内容と独立性', () => {
  test('各要求の signal は別々で、送る時点で中止されておらず、body も cookie も無い', async () => {
    const signals: AbortSignal[] = [];
    const inits: RequestInit[] = [];
    const all = fakeRepos(120);
    const fetcher: Fetcher = async (input, init) => {
      signals.push(init?.signal as AbortSignal);
      inits.push(init ?? {});
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return json(all.slice((page - 1) * 100, page * 100));
    };
    await source.listScopeCandidates(PAT, fetcher);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    for (const signal of signals) expect(signal.aborted).toBe(false);
    for (const init of inits) {
      expect(init.body).toBeUndefined();
      expect((init as { credentials?: unknown }).credentials).toBeUndefined();
      expect(Object.keys(new Headers(init.headers as HeadersInit)).length).toBe(0);
      expect(new Headers(init.headers as HeadersInit).has('cookie')).toBe(false);
    }
  });

  test('異なる PAT の並行呼び出しは互いの結果と Authorization を取り違えない', async () => {
    const a = fakePat('ParallelA');
    const b = fakePat('ParallelB');
    const fetcher: Fetcher = async (input, init) => {
      const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '');
      await new Promise((resolve) => setTimeout(resolve, token === a ? 15 : 1));
      const mine = token === a ? { id: 1, login: 'fake-a' } : { id: 2, login: 'fake-b' };
      if (String(input).endsWith('/user')) return json({ type: 'User', ...mine });
      return json([{ id: mine.id + 100, full_name: `${mine.login}/repo` }]);
    };
    const [ownerA, ownerB, listA, listB] = await Promise.all([
      source.verifyCredential(a, fetcher),
      source.verifyCredential(b, fetcher),
      source.listScopeCandidates(a, fetcher),
      source.listScopeCandidates(b, fetcher),
    ]);
    expect([ownerA.name, ownerB.name]).toEqual(['fake-a', 'fake-b']);
    expect(listA).toEqual([{ id: '101', name: 'fake-a/repo' }]);
    expect(listB).toEqual([{ id: '102', name: 'fake-b/repo' }]);
  });

  test('失敗の後に同じ取り込み元を使っても、前の状態が残らない', async () => {
    const bad = await failureOf(source.listScopeCandidates(PAT, async () => json([{ id: 1, full_name: 'x' }])));
    expect(bad.failure).toBe('unavailable');
    await expect(
      source.listScopeCandidates(PAT, async () => json([{ id: 2, full_name: 'fake-a/b' }])),
    ).resolves.toEqual([{ id: '2', name: 'fake-a/b' }]);
  });
});

describe('設定の検査', () => {
  test('プロトタイプの無いオブジェクトは {} として受ける', () => {
    expect(source.parseSettings(Object.create(null))).toEqual({});
  });

  test('毎回新しいオブジェクトを返し、書き換えが次に伝わらない', () => {
    const first = source.parseSettings({}) as Record<string, unknown>;
    first.polluted = true;
    expect(source.parseSettings({})).toEqual({});
    expect(source.parseSettings(undefined)).not.toBe(first);
  });

  test('prototype を汚染する JSON のキーは断る', () => {
    expect(source.parseSettings(JSON.parse('{"constructor":{"prototype":{"x":1}}}'))).toBeNull();
    expect(source.parseSettings(JSON.parse('{"__proto__":{"x":1}}'))).toBeNull();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('GitHub 固有の値は github/ の外に出ない', () => {
  const files = import.meta.glob('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >;
  const entries = Object.entries(files);

  test('src を読み込めている', () => {
    expect(entries.some(([path]) => path.endsWith('server/import/github/index.ts'))).toBe(true);
  });

  test('PAT の接頭辞と取り込みの通信先は import/github/ だけにある', () => {
    const offenders = entries
      .filter(([path]) => !path.includes('/server/import/github/'))
      .filter(([, text]) => /github_pat_/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  test('import/source.ts と import/index.ts は GitHub の URL も PAT の形も持たない', () => {
    for (const [path, text] of entries) {
      if (!/server\/import\/(source|index)\.ts$/.test(path)) continue;
      expect(text, path).not.toMatch(/api\.github\.com|github_pat_|Bearer|fine-grained/);
    }
  });
});
