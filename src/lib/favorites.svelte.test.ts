import { afterEach, describe, expect, test, vi } from 'vitest';
import { Favorites, type Favorite, type FavoriteTarget } from './favorites.svelte.ts';
import { callOperation } from './api.ts';
vi.mock('./api.ts', () => ({ callOperation: vi.fn() }));
const call = vi.mocked(callOperation);
const target: FavoriteTarget = {
  target_type: 'task',
  target_id: 'one',
  workspace_id: 'workspace',
  title: '架空のタスク',
};
function setup(items: Favorite[] = []) {
  let source = { scope: 'aoba/person', slug: 'aoba', items, available: true };
  return {
    favorites: new Favorites(() => source),
    replace: (next: typeof source) => {
      source = next;
    },
  };
}
afterEach(() => vi.resetAllMocks());
describe('お気に入りの共有状態', () => {
  test('成功後だけ付け外しを反映し、再取得せず新しい順で出す', async () => {
    call.mockResolvedValue({ ok: true, data: { is_favorite: true } });
    const { favorites } = setup();
    await favorites.toggle(target);
    expect(favorites.marked('task', 'one')).toBe(true);
    expect(favorites.items[0].title).toBe(target.title);
    call.mockResolvedValue({ ok: true, data: { is_favorite: false } });
    await favorites.toggle(target);
    expect(favorites.items).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
  });
  test('上限と通信失敗では星を付けない', async () => {
    const { favorites } = setup();
    for (const result of [
      { ok: false, status: 409, error: { code: 'favorite_limit', message: 'limit' } },
      { ok: false, status: 0, error: null },
    ] as const) {
      call.mockResolvedValue(result);
      await favorites.toggle(target);
      expect(favorites.items).toEqual([]);
      expect(favorites.busy('task', 'one')).toBe(false);
    }
  });
  test('同じ対象の連打は送信を重ねない', async () => {
    let finish!: (result: { ok: true; data: { is_favorite: boolean } }) => void;
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { favorites } = setup();
    const pending = favorites.toggle(target);
    expect(favorites.busy('task', 'one')).toBe(true);
    await favorites.toggle(target);
    expect(call).toHaveBeenCalledTimes(1);
    finish({ ok: true, data: { is_favorite: true } });
    await pending;
    expect(favorites.busy('task', 'one')).toBe(false);
  });
  test('組織を替えてから届いた応答は他組織へ混ぜない', async () => {
    let finish!: (result: { ok: true; data: { is_favorite: boolean } }) => void;
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { favorites, replace } = setup();
    const pending = favorites.toggle(target);
    replace({ scope: 'sakura/person', slug: 'sakura', items: [], available: true });
    finish({ ok: true, data: { is_favorite: true } });
    await pending;
    expect(favorites.items).toEqual([]);
  });
  test('読み直した一覧を優先し、閉じたワークスペースへの印はメニューに足さない', async () => {
    call.mockResolvedValue({ ok: true, data: { is_favorite: true } });
    const { favorites, replace } = setup();
    await favorites.toggle({ ...target, menuVisible: false });
    expect(favorites.marked('task', 'one')).toBe(true);
    expect(favorites.items).toEqual([]);
    replace({ scope: 'aoba/person', slug: 'aoba', items: [], available: true });
    expect(favorites.marked('task', 'one')).toBe(false);
  });
});

test('同じ組織の再取得と書き込みが競合しても、成功を現在の一覧へ反映する', async () => {
  let finish!: (result: { ok: true; data: { is_favorite: boolean } }) => void;
  call.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { favorites, replace } = setup();
  const pending = favorites.toggle(target);
  replace({ scope: 'aoba/person', slug: 'aoba', items: [], available: true });
  finish({ ok: true, data: { is_favorite: true } });
  await pending;
  expect(favorites.marked('task', 'one')).toBe(true);
  expect(favorites.items[0].target_id).toBe('one');
});

test('閉じた対象の本人の印はメニューとは別に読み、1回で外せる', async () => {
  const favorites = new Favorites(() => ({
    scope: 'aoba/person',
    slug: 'aoba',
    items: hiddenMenu,
    available: true,
    marks: [{ target_type: 'task', target_id: 'one' }],
  }));
  const hiddenMenu: Favorite[] = [];
  expect(favorites.marked('task', 'one')).toBe(true);
  expect(favorites.items).toEqual([]);
  call.mockResolvedValue({ ok: true, data: { is_favorite: false } });
  await favorites.toggle({ ...target, menuVisible: false });
  expect(favorites.marked('task', 'one')).toBe(false);
  expect(call).toHaveBeenCalledWith(
    expect.anything(),
    { target_type: 'task', target_id: 'one', is_favorite: false },
    { slug: 'aoba' },
  );
});

test('書き込み成功より前に始まった古い一覧応答で星を戻さず、新しい再取得は優先する', async () => {
  let source = { scope: 'aoba/person', slug: 'aoba', items: [] as Favorite[], available: true, requestedAt: 0 };
  const favorites = new Favorites(() => source);
  call.mockResolvedValue({ ok: true, data: { is_favorite: true } });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
  try {
    await favorites.toggle(target);
    source = { ...source, items: [], requestedAt: 5 };
    expect(favorites.marked('task', 'one')).toBe(true);
    expect(favorites.items[0].target_id).toBe('one');
    source = { ...source, items: [], requestedAt: 15 };
    expect(favorites.marked('task', 'one')).toBe(false);
    expect(favorites.items).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test('題・削除・復元の成功はお気に入りだけを再取得し、星や今日やるの操作では取得しない', async () => {
  const { notifyOperationWrite } = await import('./operation-events.ts');
  const { favorites } = setup();
  const stop = favorites.watch();
  call.mockResolvedValue({ ok: true, data: { favorites: [], marks: [] } });
  try {
    for (const name of ['favorite-set', 'task-today-mark', 'task-assign']) notifyOperationWrite({ name, slug: 'aoba' });
    notifyOperationWrite({ name: 'task-delete', slug: 'sakura' });
    expect(call).not.toHaveBeenCalled();
    for (const name of ['task-update', 'task-delete', 'task-restore', 'org-wiki-update', 'workspace-close']) {
      notifyOperationWrite({ name, slug: 'aoba' });
      await Promise.resolve();
    }
    expect(call).toHaveBeenCalledTimes(5);
    for (const [definition] of call.mock.calls) expect(definition.name).toBe('favorite-list');
    stop();
    notifyOperationWrite({ name: 'task-delete', slug: 'aoba' });
    expect(call).toHaveBeenCalledTimes(5);
  } finally {
    stop();
  }
});

test('再取得の失敗は正常な一覧と星を残し、再試行の失敗・待機・復旧を分ける', async () => {
  const row: Favorite = { ...target, id: 'mark', created_at: '' };
  const { favorites } = setup([row]);
  favorites.sync();
  call.mockResolvedValue({ ok: false, status: 500, error: null });
  const refresh = favorites.refresh(true);
  expect(favorites.loading).toBe(true);
  await refresh;
  expect(favorites.loading).toBe(false);
  expect(favorites.loadFailed).toBe(true);
  expect(favorites.available).toBe(true);
  expect(favorites.marked('task', 'one')).toBe(true);
  expect(favorites.items).toEqual([row]);
  call.mockResolvedValue({ ok: true, data: { favorites: [], marks: [] } });
  await favorites.refresh();
  expect(favorites.loadFailed).toBe(false);
  expect(favorites.items).toEqual([]);
});

test('後から始まった再取得が先に完了したら、古い失敗応答で状態を戻さない', async () => {
  let finish!: (result: { ok: false; status: number; error: null }) => void;
  call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { favorites } = setup();
  const first = favorites.refresh();
  call.mockResolvedValue({ ok: true, data: { favorites: [], marks: [] } });
  await favorites.refresh();
  finish({ ok: false, status: 500, error: null });
  await first;
  expect(favorites.loading).toBe(false);
  expect(favorites.loadFailed).toBe(false);
});

test('別組織に移動してから届いた一覧を混ぜない', async () => {
  let finish!: (result: { ok: true; data: { favorites: Favorite[]; marks: [] } }) => void;
  call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { favorites, replace } = setup();
  const pending = favorites.refresh();
  replace({ scope: 'sakura/person', slug: 'sakura', items: [], available: true });
  finish({ ok: true, data: { favorites: [{ ...target, id: 'one', created_at: '' }], marks: [] } });
  await pending;
  expect(favorites.items).toEqual([]);
  expect(favorites.loading).toBe(false);
});

test('Aで再取得中にBへ移ってAへ戻っても待機状態と古い失敗を持ち越さない', async () => {
  let finish!: (result: { ok: false; status: number; error: null }) => void;
  call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { favorites, replace } = setup();
  const pending = favorites.refresh(true);
  expect(favorites.loading).toBe(true);
  replace({ scope: 'sakura/person', slug: 'sakura', items: [], available: true });
  favorites.sync();
  replace({ scope: 'aoba/person', slug: 'aoba', items: [], available: true });
  favorites.sync();
  expect(favorites.loading).toBe(false);
  finish({ ok: false, status: 500, error: null });
  await pending;
  expect(favorites.loading).toBe(false);
  expect(favorites.loadFailed).toBe(false);
});

test('背景更新は読み上げ用の待機状態を出さず、利用者の再試行だけを通知する', async () => {
  const { favorites } = setup();
  call.mockResolvedValue({ ok: false, status: 500, error: null });
  const background = favorites.refresh();
  expect(favorites.loading).toBe(false);
  await background;
  expect(favorites.loadFailed).toBe(true);
  expect(favorites.retryFailed).toBe(false);
  const retry = favorites.refresh(true);
  expect(favorites.loading).toBe(true);
  expect(favorites.loadFailed).toBe(true);
  await retry;
  expect(favorites.loading).toBe(false);
  expect(favorites.retryFailed).toBe(true);
});

test.each([true, false])(
  '手動再試行中の背景更新をまとめ、最後の結果（成功=%s）まで待機とPromiseを保つ',
  async (succeeds) => {
    type Reply =
      | { ok: true; data: { favorites: Favorite[]; marks: Pick<Favorite, 'target_type' | 'target_id'>[] } }
      | { ok: false; status: number; error: null };
    let first!: (reply: Reply) => void;
    let next!: (reply: Reply) => void;
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    );
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          next = resolve;
        }),
    );
    const { favorites } = setup();
    let settled = false;
    const manual = favorites.refresh(true).then(() => {
      settled = true;
    });
    const background = favorites.refresh();
    const anotherBackground = favorites.refresh();
    expect(call).toHaveBeenCalledTimes(1);
    expect(favorites.loading).toBe(true);
    first({ ok: true, data: { favorites: [], marks: [] } });
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(favorites.loading).toBe(true);
    expect(settled).toBe(false);
    // 手動で連打しても同じ完了を待ち、さらに問い合わせを足さない。
    const doubleClick = favorites.refresh(true);
    expect(call).toHaveBeenCalledTimes(2);
    next(
      succeeds
        ? {
            ok: true,
            data: {
              favorites: [{ ...target, id: 'mark', created_at: '' }],
              marks: [{ target_type: target.target_type, target_id: target.target_id }],
            },
          }
        : { ok: false, status: 500, error: null },
    );
    await Promise.all([manual, background, anotherBackground, doubleClick]);
    expect(favorites.loading).toBe(false);
    expect(favorites.retryFailed).toBe(!succeeds);
    expect(favorites.items).toHaveLength(succeeds ? 1 : 0);
    expect(favorites.marked('task', 'one')).toBe(succeeds);
  },
);

test('sync前に別組織で例外応答を受けても、元の組織に待機と失敗を持ち越さない', async () => {
  let reject!: (error: Error) => void;
  call.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectCall) => {
        reject = rejectCall;
      }),
  );
  const { favorites, replace } = setup();
  const pending = favorites.refresh(true);
  replace({ scope: 'sakura/person', slug: 'sakura', items: [], available: true });
  reject(new Error('架空の読み取り例外'));
  await pending;
  replace({ scope: 'aoba/person', slug: 'aoba', items: [], available: true });
  expect(favorites.loading).toBe(false);
  expect(favorites.loadFailed).toBe(false);
  expect(favorites.retryFailed).toBe(false);
});

test('手動の最初の応答が届いた直後の背景更新も、待機を解除せず合流する', async () => {
  let finish!: (reply: { ok: true; data: { favorites: []; marks: [] } }) => void;
  call.mockResolvedValueOnce({ ok: true, data: { favorites: [], marks: [] } });
  call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { favorites } = setup();
  const manual = favorites.refresh(true);
  await Promise.resolve();
  const background = favorites.refresh();
  expect(favorites.loading).toBe(true);
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  finish({ ok: true, data: { favorites: [], marks: [] } });
  await Promise.all([manual, background]);
  expect(favorites.loading).toBe(false);
});
