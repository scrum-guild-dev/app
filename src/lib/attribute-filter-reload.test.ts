import { expect, test, vi } from 'vitest';
import {
  attributeAffectsFilter,
  completedAfterAttributeRead,
  FilteredAttributeReload,
} from './attribute-filter-reload.ts';

const filter = { assignee: '', delegatee: '', category: '', repository: '', epic: '', q: '' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('絞り込みに使っている欄だけを読み直す', () => {
  expect(attributeAffectsFilter('assignee', { ...filter, assignee: 'me' })).toBe(true);
  expect(attributeAffectsFilter('category', { ...filter, category: 'none' })).toBe(true);
  expect(attributeAffectsFilter('repository', { ...filter, repository: 'r' })).toBe(true);
  expect(attributeAffectsFilter('points', { ...filter, assignee: 'me' })).toBe(false);
  expect(attributeAffectsFilter('assignee', { ...filter, q: 'タイトル' })).toBe(false);
});

test('読み直しの間も完了の印を保ち、通常の読み直しでは外す', () => {
  expect(completedAfterAttributeRead(['done'], { done: 10 }, 20, true)).toEqual(['done']);
  expect(completedAfterAttributeRead(['done'], { done: 10 }, 20, false)).toEqual([]);
});

test('後から足された移動も待ち、読み直す間だけ状態を保つ', async () => {
  const first = deferred();
  const next = deferred();
  const read = deferred();
  let tail = first.promise;
  const reload = vi.fn(async () => {
    expect(coordinator.preservesState).toBe(true);
    await read.promise;
  });
  const coordinator = new FilteredAttributeReload({ whenIdle: () => tail, reload });
  const pending = coordinator.request();
  tail = next.promise;
  first.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reload).not.toHaveBeenCalled();
  next.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reload).toHaveBeenCalledTimes(1);
  read.resolve();
  await pending;
  expect(coordinator.preservesState).toBe(false);
});

test('移動待ちの間に画面や条件が変わったら古い保存では読み直さない', async () => {
  const move = deferred();
  const reload = vi.fn();
  let current = true;
  const coordinator = new FilteredAttributeReload({ whenIdle: () => move.promise, reload });
  const pending = coordinator.request(() => current);
  current = false;
  move.resolve();
  await pending;
  expect(reload).not.toHaveBeenCalled();
});

test('読み直しの失敗でも保護状態を戻し、次の要求を実行する', async () => {
  const idle = Promise.resolve();
  const reload = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(undefined);
  const coordinator = new FilteredAttributeReload({ whenIdle: () => idle, reload });
  await expect(coordinator.request()).rejects.toThrow('read failed');
  expect(coordinator.preservesState).toBe(false);
  await coordinator.request();
  expect(reload).toHaveBeenCalledTimes(2);
});

test('失敗した読み直し中に追加された保存も、次の読み直しで反映する', async () => {
  const idle = Promise.resolve();
  const first = deferred();
  const reload = vi
    .fn()
    .mockImplementationOnce(async () => {
      await first.promise;
      throw new Error('first failed');
    })
    .mockResolvedValueOnce(undefined);
  const coordinator = new FilteredAttributeReload({ whenIdle: () => idle, reload });
  const pending = coordinator.request();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const later = coordinator.request();
  first.resolve();
  await expect(pending).resolves.toBeUndefined();
  await later;
  expect(reload).toHaveBeenCalledTimes(2);
});

test('同じ読み直しの失敗は、待っている呼び出し元が複数あっても一度だけ知らせる', async () => {
  const idle = Promise.resolve();
  const first = deferred();
  const failed = vi.fn();
  const reload = vi.fn(async () => {
    await first.promise;
    throw new Error('read failed');
  });
  const coordinator = new FilteredAttributeReload({ whenIdle: () => idle, reload, failed });
  const pending = coordinator.request();
  const later = coordinator.request();
  first.resolve();
  await Promise.allSettled([pending, later]);
  expect(failed).toHaveBeenCalledTimes(1);
});

test('読み直し中に条件が変わったら古い画面の失敗を通知しない', async () => {
  const idle = Promise.resolve();
  const read = deferred();
  let current = true;
  const failed = vi.fn();
  const coordinator = new FilteredAttributeReload({
    whenIdle: () => idle,
    reload: async () => {
      await read.promise;
      throw new Error('old read');
    },
    failed,
  });
  const pending = coordinator.request(() => current);
  await new Promise((resolve) => setTimeout(resolve, 0));
  current = false;
  read.resolve();
  await expect(pending).rejects.toThrow('old read');
  expect(failed).not.toHaveBeenCalled();
});
