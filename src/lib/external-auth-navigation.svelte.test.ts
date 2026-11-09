import { afterEach, expect, test, vi } from 'vitest';
import { ExternalAuthNavigation, EXTERNAL_AUTH_RETRY_MS } from './external-auth-navigation.svelte.ts';

const click = (changes: Partial<MouseEvent> = {}) =>
  ({
    button: 0,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...changes,
  }) as unknown as MouseEvent;

afterEach(() => vi.useRealTimers());

test('通常の押下を通し、待機中は別のプロバイダーも止める', () => {
  vi.useFakeTimers();
  const navigation = new ExternalAuthNavigation();
  const first = click();
  navigation.start(first, 'github');
  expect(first.preventDefault).not.toHaveBeenCalled();
  expect(navigation.moving).toBe('github');
  const next = click();
  navigation.start(next, 'google');
  expect(next.preventDefault).toHaveBeenCalledOnce();
  expect(navigation.moving).toBe('github');
  navigation.reset();
});

test('遷移が完了しなくても時間切れで再試行でき、再試行の待機を古いタイマーが解除しない', () => {
  vi.useFakeTimers();
  const navigation = new ExternalAuthNavigation();
  navigation.start(click(), 'github');
  vi.advanceTimersByTime(EXTERNAL_AUTH_RETRY_MS - 1);
  expect(navigation.moving).toBe('github');
  vi.advanceTimersByTime(1);
  expect(navigation.moving).toBeNull();
  const retry = click();
  navigation.start(retry, 'google');
  expect(retry.preventDefault).not.toHaveBeenCalled();
  expect(navigation.moving).toBe('google');
  navigation.reset();
  vi.advanceTimersByTime(EXTERNAL_AUTH_RETRY_MS - 1);
  navigation.start(click(), 'github');
  vi.advanceTimersByTime(1);
  expect(navigation.moving).toBe('github');
  navigation.reset();
});

for (const changes of [
  { button: 1 },
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { altKey: true },
  { defaultPrevented: true },
]) {
  test(`別タブなどの操作は待機中にしない: ${JSON.stringify(changes)}`, () => {
    const navigation = new ExternalAuthNavigation();
    const event = click(changes);
    navigation.start(event, 'github');
    expect(navigation.moving).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
}
