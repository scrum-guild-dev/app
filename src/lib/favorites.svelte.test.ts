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
