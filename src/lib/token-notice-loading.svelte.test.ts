import { afterEach, expect, test, vi } from 'vitest';
import { TokenNoticeLoading } from './token-notice-loading.svelte.ts';

afterEach(() => vi.useRealTimers());

test('299msでは帯を出さず、300msから出し、応答で消す', () => {
  vi.useFakeTimers();
  const loading = new TokenNoticeLoading();
  const stop = loading.begin();
  expect(loading.visible).toBe(false);
  vi.advanceTimersByTime(299);
  expect(loading.visible).toBe(false);
  vi.advanceTimersByTime(1);
  expect(loading.visible).toBe(true);
  stop();
  expect(loading.visible).toBe(false);
});

test('速い応答と破棄では後から帯を出さず、次の読み込みへ古いタイマーを持ち越さない', () => {
  vi.useFakeTimers();
  const loading = new TokenNoticeLoading();
  const first = loading.begin();
  vi.advanceTimersByTime(200);
  first();
  const second = loading.begin();
  vi.advanceTimersByTime(100);
  expect(loading.visible).toBe(false);
  vi.advanceTimersByTime(199);
  expect(loading.visible).toBe(false);
  second();
  vi.advanceTimersByTime(1000);
  expect(loading.visible).toBe(false);
});
