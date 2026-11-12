import { describe, expect, it } from 'vitest';
import { shouldFadeNavigation, type NavigationFadeInput } from './navigation-fade.ts';

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

  it('戻る・進むと、ページを離れる移動では入れ替えない', () => {
    expect(shouldFadeNavigation({ ...base, type: 'popstate' })).toBe(false);
    expect(shouldFadeNavigation({ ...base, type: 'leave' })).toBe(false);
    expect(shouldFadeNavigation({ ...base, type: 'form' })).toBe(false);
  });

  it('同じ画面の中の移動と、行き先か元が分からない移動では入れ替えない', () => {
    expect(shouldFadeNavigation({ ...base, to: '/aoba' })).toBe(false);
    expect(shouldFadeNavigation({ ...base, from: undefined })).toBe(false);
    expect(shouldFadeNavigation({ ...base, to: undefined })).toBe(false);
  });
});
