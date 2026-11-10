import { flushSync } from 'svelte';
import { expect, test } from 'vitest';
import { PageHeadOwners } from './page-head-owners.svelte.ts';

test('通常の見出しと失敗の見出しが共存しても、入口は最初の1つが持つ', () => {
  const owners = new PageHeadOwners();
  const normal = Symbol('通常');
  const failure = Symbol('失敗');
  expect(owners.empty).toBe(true);
  const removeNormal = owners.register(normal);
  const removeFailure = owners.register(failure);
  expect(owners.empty).toBe(false);
  expect(owners.owns(normal)).toBe(true);
  expect(owners.owns(failure)).toBe(false);
  removeFailure();
  expect(owners.owns(normal)).toBe(true);
  removeNormal();
  expect(owners.empty).toBe(true);
});

test('入口を持つ見出しが消えたら次へ移り、最後が消えたら代わりの見出しへ戻れる', () => {
  const owners = new PageHeadOwners();
  const first = Symbol('先の画面');
  const next = Symbol('次の画面');
  const removeFirst = owners.register(first);
  const removeNext = owners.register(next);
  removeFirst();
  expect(owners.owns(first)).toBe(false);
  expect(owners.owns(next)).toBe(true);
  expect(owners.empty).toBe(false);
  removeNext();
  expect(owners.empty).toBe(true);
  const later = Symbol('もう一度開く');
  const removeLater = owners.register(later);
  expect(owners.owns(later)).toBe(true);
  removeLater();
});

test('所有者の交代と解除が描画へ伝わり、2組の入口を同時に有効にしない', () => {
  const owners = new PageHeadOwners();
  const first = Symbol('通常');
  const second = Symbol('失敗');
  const seen: string[] = [];
  const cleanup = $effect.root(() => {
    const active = $derived(owners.empty ? '代わり' : owners.owns(first) ? '通常' : '失敗');
    $effect(() => {
      seen.push(active);
    });
  });
  try {
    flushSync();
    const removeFirst = owners.register(first);
    flushSync();
    const removeSecond = owners.register(second);
    flushSync();
    removeFirst();
    flushSync();
    removeSecond();
    flushSync();
    expect(seen).toEqual(['代わり', '通常', '失敗', '代わり']);
  } finally {
    cleanup();
  }
});
