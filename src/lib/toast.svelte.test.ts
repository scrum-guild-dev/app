import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissToast, runToastAction, showToast, toasts } from './toast.svelte.ts';

afterEach(() => {
  for (const toast of [...toasts]) dismissToast(toast.id, true);
  vi.useRealTimers();
});

describe('onclose', () => {
  it('時間切れで消えたときに1回だけ呼ぶ', () => {
    vi.useFakeTimers();
    const onclose = vi.fn();
    showToast('消す', 'check', { label: '取り消す', run: () => {} }, onclose);
    vi.advanceTimersByTime(9_999);
    expect(onclose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(0);
  });

  it('操作を押したときは run だけを呼び、onclose は呼ばない', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const onclose = vi.fn();
    const id = showToast('消す', 'check', { label: '取り消す', run }, onclose);
    runToastAction(id);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(onclose).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it('あふれて押し出されたときも呼ぶ', () => {
    const onclose = vi.fn();
    showToast('古い', undefined, undefined, onclose);
    for (const message of ['a', 'b', 'c']) showToast(message);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('silent で消すと呼ばない', () => {
    const onclose = vi.fn();
    const id = showToast('x', undefined, undefined, onclose);
    dismissToast(id, true);
    expect(onclose).not.toHaveBeenCalled();
  });
});
