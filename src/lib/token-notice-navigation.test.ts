import { expect, test } from 'vitest';
import { shouldRefreshTokenNotice } from './token-notice-navigation.ts';

const navigation = { type: 'link', fromSlug: 'aoba', fromPath: '/aoba', toPath: '/aoba/me' };

test('最初にページへ入るときは load の結果を使い、重ねて読まない', () => {
  expect(shouldRefreshTokenNotice({ ...navigation, type: 'enter' }, 'aoba')).toBe(false);
});
test('同じ組織の経路が変われば読み直す', () => {
  expect(shouldRefreshTokenNotice(navigation, 'aoba')).toBe(true);
});
test('招待の画面から同じ組織へ戻る再マウントも読み直す', () => {
  expect(shouldRefreshTokenNotice({ ...navigation, fromPath: '/aoba/invitations', toPath: '/aoba' }, 'aoba')).toBe(
    true,
  );
});
test('別の組織から入ったときは新しい load の結果を使う', () => {
  expect(shouldRefreshTokenNotice({ ...navigation, fromSlug: 'hibari', fromPath: '/hibari' }, 'aoba')).toBe(false);
});
test('query や hash だけの移動では読み直さない', () => {
  expect(shouldRefreshTokenNotice({ ...navigation, toPath: '/aoba' }, 'aoba')).toBe(false);
});
test('アプリの外からの移動で前の組織が無いときは重ねて読まない', () => {
  expect(shouldRefreshTokenNotice({ ...navigation, fromSlug: undefined, fromPath: undefined }, 'aoba')).toBe(false);
});
