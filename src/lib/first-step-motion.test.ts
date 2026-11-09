import { afterEach, describe, expect, test, vi } from 'vitest';
import { firstStepMotion } from './first-step-motion.ts';

function setup(reduced = false, blocked = false) {
  const saved = new Map<string, string>();
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: reduced }),
    sessionStorage: {
      getItem(key: string) {
        if (blocked) throw new Error('storage unavailable');
        return saved.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (blocked) throw new Error('storage unavailable');
        saved.set(key, value);
      },
    },
  });
  return () => {
    const classes = new Set<string>();
    return Object.assign(new EventTarget(), {
      classList: {
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
        contains: (name: string) => classes.has(name),
      },
    }) as unknown as HTMLElement;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('手順の完了をまたいだ演出', () => {
  const key = 'aoba/member/leader/invite_members';
  test('初期済みと画面を開き直した済みは押さない', () => {
    const node = setup();
    for (let i = 0; i < 2; i++) {
      const element = node();
      firstStepMotion(element, { key, done: true }).destroy();
      expect(element.classList.contains('is-new')).toBe(false);
    }
  });
  test('別画面で済ませて戻った分だけ押し、同値の更新と次の表示では繰り返さない', () => {
    const node = setup();
    firstStepMotion(node(), { key, done: false }).destroy();
    const element = node();
    const motion = firstStepMotion(element, { key, done: true });
    expect(element.classList.contains('is-new')).toBe(true);
    element.dispatchEvent(new Event('animationend'));
    motion.update({ key, done: true });
    expect(element.classList.contains('is-new')).toBe(false);
    motion.destroy();
    const next = node();
    firstStepMotion(next, { key, done: true });
    expect(next.classList.contains('is-new')).toBe(false);
  });
  test('別の利用者や組織の手順の状態を流用しない', () => {
    const node = setup();
    firstStepMotion(node(), { key, done: false });
    const element = node();
    firstStepMotion(element, { key: 'hibari/other/leader/invite_members', done: true });
    expect(element.classList.contains('is-new')).toBe(false);
  });
  test('動きを減らす設定では完了を記録しても押さない', () => {
    const node = setup(true);
    firstStepMotion(node(), { key, done: false });
    const element = node();
    firstStepMotion(element, { key, done: true });
    expect(element.classList.contains('is-new')).toBe(false);
  });
  test('保存を使えなくても表示中の変化だけを押し、中断と取り消しで消す', () => {
    const node = setup(false, true);
    const element = node();
    const motion = firstStepMotion(element, { key, done: false });
    motion.update({ key, done: true });
    expect(element.classList.contains('is-new')).toBe(true);
    element.dispatchEvent(new Event('animationcancel'));
    expect(element.classList.contains('is-new')).toBe(false);
    motion.update({ key, done: false });
    motion.update({ key, done: true });
    motion.update({ key, done: false });
    expect(element.classList.contains('is-new')).toBe(false);
  });
});
