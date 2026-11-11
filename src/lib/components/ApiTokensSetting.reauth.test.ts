// 再認証の案内（ApiTokensSetting.svelte の canCreate、loginProvider、slug）の崩し。ApiTokensSetting.test.ts の
// github と google の基本と重ならない手口: 手段が不明、slug に特殊な文字、発行できるときは発行専用の案内を出さない
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import { dictionary } from '../../shared/vocabulary.ts';
import ApiTokensSetting from './ApiTokensSetting.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/aoba/me') } }));

const renderWith = (props: { canCreate: boolean; loginProvider: string | null; slug: string }) =>
  render(ApiTokensSetting, { props: { initial: [], ...props } }).body;

// 「ログインし直す」のリンクの href（HTML の実体参照を戻す）
function reauthHref(body: string): string {
  const match = /<a[^>]*href="([^"]*)"[^>]*>(?:締め出す前に)?ログインし直す/.exec(body);
  expect(match, 'ログインし直すのリンク').not.toBeNull();
  return match![1]!.replaceAll('&amp;', '&');
}

test('発行できる（canCreate が true）なら、手段が何でも、発行専用の再認証案内を出さず発行の欄を出す', () => {
  for (const loginProvider of ['github', 'google', null, 'saml']) {
    const body = renderWith({ canCreate: true, loginProvider, slug: 'aoba' });
    expect(body, String(loginProvider)).not.toContain('API トークンを発行するには、ログインし直してください。');
    expect(body, String(loginProvider)).toContain('<form');
  }
});

test.each([null, 'saml', '', 'GitHub', 'github/../x', 'github?x=1'])(
  '手段が %j（不明）なら、手段を推測せず、ログインの画面（/login）へ return_to を付けて送る',
  (loginProvider) => {
    const body = renderWith({ canCreate: false, loginProvider, slug: 'aoba' });
    const href = reauthHref(body);
    expect(href).toBe('/login?return_to=%2Faoba%2Fme');
    expect(href).not.toContain('/api/auth/');
    expect(body).not.toContain('<form');
  },
);

test('再認証の案内は猶予の分数を辞書の文言どおりに出し、「{minutes}」を残さない', () => {
  const body = renderWith({ canCreate: false, loginProvider: 'github', slug: 'aoba' });
  expect(body).not.toContain('{minutes}');
  expect(body).toContain('10分以内');
  for (const key of ['apiTokenReauthRequired', 'apiTokenReauth'] as const) {
    expect(dictionary[key].length, key).toBeGreaterThan(0);
  }
});

test('一覧が空なら通常の空の文を出し、再認証の理由とロックは案内の1か所だけに出す', () => {
  const needs = renderWith({ canCreate: false, loginProvider: 'github', slug: 'aoba' });
  const ok = renderWith({ canCreate: true, loginProvider: 'github', slug: 'aoba' });
  for (const body of [needs, ok]) {
    expect(body).toContain(dictionary.apiTokenEmptyTitle);
    expect(body).toContain(dictionary.apiTokenEmptyText);
  }
  // 全失効にも再ログインの説明があるため、発行の猶予を説明する文だけを数える。
  expect(needs.match(/API トークンを発行するには、ログインし直してください。/g)).toHaveLength(1);
  expect(needs.match(/#i-lock/g)).toHaveLength(1);
  expect(needs).toContain('class="callout is-info"');
});

test('発行の欄が無いとき、空の文は存在しないフォームを指さない', () => {
  const needs = renderWith({ canCreate: false, loginProvider: 'github', slug: 'aoba' });
  expect(needs).not.toContain('<form');
  expect(needs).not.toContain('上のフォーム');
});

test('再認証リンクの説明は、同じ案内の理由の本文を指す', () => {
  const body = renderWith({ canCreate: false, loginProvider: 'github', slug: 'aoba' });
  const link = /<a[^>]*aria-describedby="([^"]+)"[^>]*>(?:締め出す前に)?ログインし直す/.exec(body);
  expect(link).not.toBeNull();
  expect(body).toContain(`<span id="${link![1]}">API トークンを発行するには、ログインし直してください。`);
});

// slug に特殊な文字があっても、return_to は自分のサイトの1つのパスに収まり、別のサイトや API に向かない
test.each([
  ['a?b#c', '/a?b#c/me'],
  ['a b', '/a b/me'],
  ['a&return_to=//evil.example', '/a&return_to=//evil.example/me'],
])('slug %j は return_to に1つの値として符号化される', (slug, expected) => {
  const href = reauthHref(renderWith({ canCreate: false, loginProvider: 'github', slug }));
  const url = new URL(href, 'http://localhost');
  expect(url.pathname).toBe('/api/auth/github/start');
  expect([...url.searchParams.keys()]).toEqual(['return_to']);
  expect(url.searchParams.get('return_to')).toBe(expected);
});

test.each(['..', '.', '%2e%2e', 'api', '%61pi', 'login', 'signup', 'a\\b', 'あおば'])(
  '安全でない slug %j は、return_to を `/` に落とす（ログインが終わらない先や別のサイトへ戻さない）',
  (slug) => {
    for (const loginProvider of ['github', null]) {
      const href = reauthHref(renderWith({ canCreate: false, loginProvider, slug }));
      const returnTo = new URL(href, 'http://localhost').searchParams.get('return_to');
      expect(returnTo, `${slug}/${String(loginProvider)}`).toBe('/');
    }
  },
);

test.each(['github', 'google', null])(
  '発行できるときも、全失効からの再ログインは安全な戻り先を使う: %j',
  (loginProvider) => {
    const body = renderWith({ canCreate: true, loginProvider, slug: 'aoba' });
    const href = reauthHref(body);
    expect(href).toBe(
      loginProvider === null
        ? '/login?return_to=%2Faoba%2Fme'
        : `/api/auth/${loginProvider}/start?return_to=%2Faoba%2Fme`,
    );
  },
);
