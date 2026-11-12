import { describe, expect, it, vi } from 'vitest';
import { shouldFadeNavigation, startNavigationFade, type NavigationFadeInput } from './navigation-fade.ts';

const base: NavigationFadeInput = {
  narrow: true,
  reducedMotion: false,
  supported: true,
  type: 'link',
  from: '/aoba',
  to: '/aoba/favorites',
};

describe('shouldFadeNavigation', () => {
  it('狭い幅でリンクか goto で別の画面へ移るときは入れ替える', () => {
    expect(shouldFadeNavigation(base)).toBe(true);
    expect(shouldFadeNavigation({ ...base, type: 'goto' })).toBe(true);
  });

  it('広い幅、動きを減らす設定、未対応のブラウザでは入れ替えない', () => {
    expect(shouldFadeNavigation({ ...base, narrow: false })).toBe(false);
    expect(shouldFadeNavigation({ ...base, reducedMotion: true })).toBe(false);
    expect(shouldFadeNavigation({ ...base, supported: false })).toBe(false);
  });

  it('戻る・進むと、フォームの送信では入れ替えない', () => {
    expect(shouldFadeNavigation({ ...base, type: 'popstate' })).toBe(false);
    expect(shouldFadeNavigation({ ...base, type: 'form' })).toBe(false);
  });

  it('同じ画面の中の移動と、行き先か元が分からない移動では入れ替えない', () => {
    expect(shouldFadeNavigation({ ...base, to: '/aoba' })).toBe(false);
    expect(shouldFadeNavigation({ ...base, from: undefined })).toBe(false);
    expect(shouldFadeNavigation({ ...base, to: undefined })).toBe(false);
  });
});

describe('startNavigationFade', () => {
  it('入れ替えの更新が始まったら解け、描き終える（complete）まで更新を待つ', async () => {
    let finish!: () => void;
    const complete = new Promise<void>((resolve) => (finish = resolve));
    let update: Promise<void> | undefined;
    const start = vi.fn((cb: () => Promise<void>) => {
      update = cb();
      return { finished: Promise.resolve(), ready: Promise.resolve() };
    });
    await startNavigationFade(complete, start);
    expect(start).toHaveBeenCalledTimes(1);
    let updated = false;
    void update!.then(() => (updated = true));
    await Promise.resolve();
    expect(updated).toBe(false);
    finish();
    await update;
    expect(updated).toBe(true);
  });

  it('入れ替えを始められず投げたときは、入れ替えずに解ける', async () => {
    await expect(
      startNavigationFade(Promise.resolve(), () => {
        throw new Error('InvalidStateError');
      }),
    ).resolves.toBeUndefined();
  });

  it('移動が失敗し、入れ替えが取り消されても、拒否を外へ漏らさない', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let update: Promise<void> | undefined;
      await startNavigationFade(Promise.reject(new Error('aborted')), (cb) => {
        update = cb();
        return { finished: Promise.reject(new Error('skipped')), ready: Promise.reject(new Error('skipped')) };
      });
      await expect(update).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
