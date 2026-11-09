import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flashRow } from './flash-row.ts';

let reduced = false;
function element() {
  const classes = new Set<string>();
  return {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
  } as unknown as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  reduced = false;
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('変わった行の光', () => {
  test('成功の印で一度だけ光り、時間が来ると消える。同じ印や古い印では再演出しない', () => {
    const row = element();
    const action = flashRow(row, 1000);
    vi.advanceTimersByTime(32);
    expect(row.classList.contains('is-dropped')).toBe(true);
    vi.advanceTimersByTime(900);
    expect(row.classList.contains('is-dropped')).toBe(false);
    action.update(1000);
    vi.advanceTimersByTime(32);
    expect(row.classList.contains('is-dropped')).toBe(false);
    flashRow(row, 50);
    vi.advanceTimersByTime(32);
    expect(row.classList.contains('is-dropped')).toBe(false);
    action.destroy();
  });
  test('初回、動きを減らす設定、描画前に破棄された行には光を付けない', () => {
    const row = element();
    const action = flashRow(row);
    vi.advanceTimersByTime(32);
    expect(row.classList.contains('is-dropped')).toBe(false);
    reduced = true;
    action.update(1000);
    vi.advanceTimersByTime(32);
    expect(row.classList.contains('is-dropped')).toBe(false);
    reduced = false;
    action.update(1001);
    action.destroy();
    vi.advanceTimersByTime(32);
    expect(row.classList.contains('is-dropped')).toBe(false);
  });
});
