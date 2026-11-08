import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { accountProfileSaveOperation, onboardingStatusOperation } from '../src/server/operations/onboarding.ts';
import { accountProfileSave, onboardingStatus } from '../src/shared/operations/session/onboarding.ts';
import { createMyOrganization, createPersonalOrganization } from '../src/shared/operations/organization/index.ts';
import {
  createAccount,
  createAccountLogin,
  createOrganization,
  createPersonalOrganizationRow,
  createSessionWithToken,
  createUser,
} from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';

// 入れ物の時点でも入口の検査を通す。本番一覧へ登録された後も同じ操作を二重に登録しない。
const handlers = [accountProfileSaveOperation, onboardingStatusOperation];
const names = new Set(handlers.map((operation) => operation.definition.name));
const app = createApp([
  ...implementedOperations.filter((operation) => !names.has(operation.definition.name)),
  ...handlers,
]);
const newSlug = () => `setup-${crypto.randomUUID().slice(0, 12)}`;

async function member(consented = true) {
  const account = await createAccount({}, { consented });
  const login = await createAccountLogin(account.id, { login_name: 'yui-original-login' });
  const { token } = await createSessionWithToken(account.id);
  return { accountId: account.id, token, login };
}
type Member = Awaited<ReturnType<typeof member>>;
const profile = { name: '結城 ユイ', title: 'エンジニア' };
const save = (who: Member, body: unknown = profile) => post(app, accountProfileSave, { token: who.token, body });
const status = (who: Member) => post(app, onboardingStatus, { token: who.token });

async function personal(who: Member, options: { suspended?: boolean; disabled?: boolean } = {}) {
  const organization = await createPersonalOrganizationRow(who.accountId, {
    slug: newSlug(),
    ...(options.suspended ? { suspended_at: '2026-11-01T00:00:00.000Z' } : {}),
  });
  await createUser(organization, {
    account_id: who.accountId,
    login_provider: who.login.login_provider,
    login_subject: who.login.login_subject,
    is_admin: 1,
    ...(options.disabled ? { disabled_at: '2026-11-01T00:00:00.000Z' } : {}),
  });
  return organization;
}

async function createdUser(slug: string, accountId: string) {
  const db = commonDb(env);
  const organization = await db.first(
    db.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', slug)),
  );
  expect(organization).toBeDefined();
  const scoped = orgDb(env, verifiedOrganizationForTest(organization!.id));
  return scoped.first(
    scoped.statement((q) =>
      q
        .selectFrom('users')
        .select(['id', 'name'])
        .where('organization_id', '=', organization!.id)
        .where('account_id', '=', accountId),
    ),
  );
}

describe('導入フローのプロフィールと状態', () => {
  test('プロフィールも自分用もない会員は両方null', async () => {
    const who = await member();
    const res = await status(who);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: null, personal: null });
  });

  test('保存は前後の空白を除き、別のセッションから読み直しても値を保持する', async () => {
    const who = await member();
    const res = await save(who, { name: '  結城 ユイ　', title: ' エンジニア ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(profile);
    const { token } = await createSessionWithToken(who.accountId);
    const read = await status({ ...who, token });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ profile, personal: null });
  });

  test('同じアカウントの再保存は上書きし、肩書きは空にできる', async () => {
    const who = await member();
    expect((await save(who)).status).toBe(200);
    const next = { name: 'ユイ', title: '' };
    const res = await save(who, next);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(next);
    expect(await (await status(who)).json()).toEqual({ profile: next, personal: null });
  });

  test('別アカウントにはプロフィールと自分用を返さず、その人の保存で元のプロフィールを変えない', async () => {
    const first = await member();
    const second = await member();
    expect((await save(first)).status).toBe(200);
    const own = await personal(first);
    expect(await (await status(second)).json()).toEqual({ profile: null, personal: null });
    const otherProfile = { name: '蓮', title: 'デザイナー' };
    expect((await save(second, otherProfile)).status).toBe(200);
    expect(await (await status(first)).json()).toEqual({ profile, personal: { slug: own.slug, available: true } });
  });

  test('入力に他アカウントのIDを足しても呼び出した本人だけを保存する', async () => {
    const first = await member();
    const second = await member();
    expect((await save(first, { ...profile, account_id: second.accountId })).status).toBe(200);
    expect(await (await status(first)).json()).toEqual({ profile, personal: null });
    expect(await (await status(second)).json()).toEqual({ profile: null, personal: null });
  });

  test.each(['name', 'title'] as const)('%sは100コードポイントまで保存できる', async (field) => {
    const who = await member();
    const value = { ...profile, [field]: '🌸'.repeat(100) };
    const res = await save(who, value);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(value);
  });

  test.each([
    { name: '', title: '' },
    { name: '　 ', title: '' },
    { name: '名'.repeat(101), title: '' },
    { name: 'ユイ', title: '肩'.repeat(101) },
    { name: 'ユ\u0000イ', title: '' },
    { name: 'ユ\u200bイ', title: '' },
    { name: 'ユイ', title: 'エン\nジニア' },
    { name: 'ユイ', title: 'エン\u202eジニア' },
  ])('不正なプロフィールを400で断り、先に保存した値を壊さない（%j）', async (invalid) => {
    const who = await member();
    expect((await save(who)).status).toBe(200);
    const res = await save(who, invalid);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await (await status(who)).json()).toEqual({ profile, personal: null });
  });

  test('入れる自分用はavailable=trueで、プロフィール未保存でも返す', async () => {
    const who = await member();
    const own = await personal(who);
    const res = await status(who);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: null, personal: { slug: own.slug, available: true } });
  });

  test.each([{ suspended: true }, { disabled: true }])('入れない自分用も作成済みとして返す（%j）', async (options) => {
    const who = await member();
    const own = await personal(who, options);
    const res = await status(who);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: null, personal: { slug: own.slug, available: false } });
  });

  test('他人が作成した個人用や本人のチーム組織を自分用と取り違えない', async () => {
    const who = await member();
    await personal(await member());
    await createOrganization({
      created_by_account_id: who.accountId,
      slug: newSlug(),
      created_by_operator: 'self-service',
    });
    const res = await status(who);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: null, personal: null });
  });

  for (const definition of [accountProfileSave, onboardingStatus]) {
    describe(definition.name, () => {
      test('ログインした本人のCookieだけが使え、同意の例外を持たない', () => {
        expect(definition).toMatchObject({ permission: 'login', cookieOnly: true });
        expect(definition).not.toHaveProperty('skipsConsent');
      });
      test('未ログインは401', async () => {
        const res = await post(app, definition, { body: definition === accountProfileSave ? profile : {} });
        expect(res.status).toBe(401);
        expect(await errorCodeOf(res)).toBe('unauthenticated');
      });
      test('未同意の会員は403', async () => {
        const who = await member(false);
        const res = await post(app, definition, {
          token: who.token,
          body: definition === accountProfileSave ? profile : {},
        });
        expect(res.status).toBe(403);
        expect(await errorCodeOf(res)).toBe('terms_required');
      });
      test('別Originからは403', async () => {
        const who = await member();
        const res = await post(app, definition, {
          token: who.token,
          origin: 'https://evil.example',
          body: definition === accountProfileSave ? profile : {},
        });
        expect(res.status).toBe(403);
        expect(await errorCodeOf(res)).toBe('forbidden');
      });
      test.each(['read', 'write'] as const)('%sのAPIトークンは403', async (scope) => {
        const who = await member();
        const res = await post(app, definition, {
          bearer: await bearerFor(who, scope),
          body: definition === accountProfileSave ? profile : {},
        });
        expect(res.status).toBe(403);
        expect(await errorCodeOf(res)).toBe('forbidden');
      });
    });
  }
});

describe('新しく自分で作る組織の表示する名前', () => {
  for (const definition of [createPersonalOrganization, createMyOrganization]) {
    test(`${definition.name}は保存したプロフィール名を最初の管理者へ使う`, async () => {
      const who = await member();
      expect((await save(who)).status).toBe(200);
      const slug = newSlug();
      const res = await post(app, definition, {
        token: who.token,
        body: { slug, ...(definition === createMyOrganization ? { name: 'ひばり工房' } : {}) },
      });
      expect(res.status).toBe(200);
      expect((await createdUser(slug, who.accountId))?.name).toBe(profile.name);
    });

    test(`${definition.name}は未保存なら元のlogin_nameを使う`, async () => {
      const who = await member();
      const slug = newSlug();
      const res = await post(app, definition, {
        token: who.token,
        body: { slug, ...(definition === createMyOrganization ? { name: 'ひばり工房' } : {}) },
      });
      expect(res.status).toBe(200);
      expect((await createdUser(slug, who.accountId))?.name).toBe(who.login.login_name);
    });
  }

  test('プロフィールを保存しても既存組織のユーザー名を変更しない', async () => {
    const who = await member();
    const organization = await createOrganization();
    const user = await createUser(organization, {
      account_id: who.accountId,
      login_provider: who.login.login_provider,
      login_subject: who.login.login_subject,
      name: '前からの名前',
      is_admin: 1,
    });
    expect((await save(who)).status).toBe(200);
    expect(await createdUser(organization.slug, who.accountId)).toEqual({ id: user.id, name: '前からの名前' });
  });
});
