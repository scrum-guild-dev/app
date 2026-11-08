import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { accountProfileSave, onboardingStatus } from '../src/shared/operations/session/onboarding.ts';
import {
  createAccount,
  createAccountLogin,
  createPersonalOrganizationRow,
  createSessionWithToken,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';

const app = createApp(implementedOperations);
const profile = { name: 'ユイ', title: 'エンジニア' };

async function member() {
  const account = await createAccount();
  await createAccountLogin(account.id);
  const session = await createSessionWithToken(account.id);
  return { accountId: account.id, token: session.token };
}
type Member = Awaited<ReturnType<typeof member>>;
const save = (who: Member, value: unknown) => post(app, accountProfileSave, { token: who.token, body: value });
const status = (who: Member) => post(app, onboardingStatus, { token: who.token });

describe('プロフィールの保存境界を崩す', () => {
  // D1 は不正なUTF-16をU+FFFDに変える。受理すると保存の応答と読み直しが別の値になる。
  // token-create の名前も同じ理由で isWellFormed() を要求する。
  for (const field of ['name', 'title'] as const) {
    for (const malformed of ['\ud800', '\udc00']) {
      test(`${field}の単独サロゲート${malformed.charCodeAt(0).toString(16)}を400で断り、保存済みの値を守る`, async () => {
        const who = await member();
        expect((await save(who, profile)).status).toBe(200);
        const res = await save(who, { ...profile, [field]: `前${malformed}後` });
        const response: unknown = await res.clone().json();
        const read = await (await status(who)).json();
        expect(res.status, JSON.stringify({ response, read })).toBe(400);
        expect(await errorCodeOf(res)).toBe('invalid_input');
        expect(read).toEqual({ profile, personal: null });
      });
    }
  }

  test('正常な補助平面の文字と結合文字列は変換せずに保存・再読する', async () => {
    const who = await member();
    const value = { name: '🌸'.repeat(100), title: 'e\u0301'.repeat(50) };
    const res = await save(who, value);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(value);
    expect(await (await status(who)).json()).toEqual({ profile: value, personal: null });
  });

  test('同時の保存でもnameとtitleが別の要求から混ざらず1つのプロフィールになる', async () => {
    const who = await member();
    const first = { name: 'ユイ', title: '設計' };
    const second = { name: 'レン', title: '開発' };
    const replies = await Promise.all([save(who, first), save(who, second)]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const body = (await (await status(who)).json()) as { profile: typeof first; personal: null };
    expect([first, second]).toContainEqual(body.profile);
    expect(body.personal).toBeNull();
  });

  test('所有する自分用の組織にusers行がなくても存在を隠さずavailable=falseにする', async () => {
    const who = await member();
    const own = await createPersonalOrganizationRow(who.accountId, {
      slug: `missing-user-${crypto.randomUUID().slice(0, 8)}`,
    });
    const res = await status(who);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: null, personal: { slug: own.slug, available: false } });
  });
});
