import { afterEach, expect, test, vi } from 'vitest';
import { NavigationLoading, navigationLoadingKind } from './navigation-loading.svelte.ts';

const target = (path: string, id: string | null = '/[slug]/w/[id]') => ({
  route: { id },
  url: new URL(path, 'https://example.test'),
});

afterEach(() => vi.useRealTimers());

test('組織の中のパス変更だけを本文の待ちにする', () => {
  const from = target('/aoba/w/one');
  expect(navigationLoadingKind(from, target('/aoba/w/one/sprint'))).toBe('inside');
  for (const path of ['/aoba/w/one?task=one', '/aoba/w/one?q=word', '/aoba/w/one#heading']) {
    expect(navigationLoadingKind(from, target(path))).toBeNull();
  }
  expect(navigationLoadingKind(from, target('/login', '/login'))).toBeNull();
  expect(navigationLoadingKind(from, null)).toBeNull();
});

test('枠の外からは既存の読み込みの紙を使う', () => {
  expect(navigationLoadingKind(target('/', '/'), target('/aoba'))).toBe('outside');
  expect(navigationLoadingKind(null, target('/aoba'))).toBe('outside');
});

for (const kind of ['inside', 'outside'] as const) {
  test(`${kind}: 300msから表示し、完了・中断で解除する`, () => {
    vi.useFakeTimers();
    const loading = new NavigationLoading();
    const stop = loading.begin(kind);
    vi.advanceTimersByTime(299);
    expect(loading.kind).toBeNull();
    vi.advanceTimersByTime(1);
    expect(loading.kind).toBe(kind);
    stop();
    expect(loading.kind).toBeNull();
    const stopFast = loading.begin(kind);
    vi.advanceTimersByTime(299);
    stopFast();
    vi.advanceTimersByTime(1000);
    expect(loading.kind).toBeNull();
  });
}

test('後の移動では数え直し、古いタイマーを残さない', () => {
  vi.useFakeTimers();
  const loading = new NavigationLoading();
  const first = loading.begin('inside');
  vi.advanceTimersByTime(200);
  first();
  const second = loading.begin('inside');
  vi.advanceTimersByTime(100);
  expect(loading.kind).toBeNull();
  vi.advanceTimersByTime(200);
  expect(loading.kind).toBe('inside');
  second();
  const stop = loading.begin(null);
  vi.advanceTimersByTime(1000);
  expect(loading.kind).toBeNull();
  stop();
});
