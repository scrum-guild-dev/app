// #716: 発行の知らせはセッションごと。発行側の確認や再ログインで別端末の未確認を消さない。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { deleteExpiredApiTokens, issueApiTokenWith } from '../src/server/auth/api-token.ts';
import { createSession, hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { tokenCreate, tokenNotice, tokenNoticeSeen, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { createAccount, createSessionWithToken } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const DAY = 86_400_000;
const ago = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString();
const future = () => new Date(Date.now() + DAY).toISOString();

type Notice = {
  count: number;
  latest: null | { name: string; scope: 'read' | 'write'; created_at: string; revoked: boolean };
};
const read = (token: string) => post(app, tokenNotice, { token });
const seen = (token: string, created_at: string) => post(app, tokenNoticeSeen, { token, body: { created_at } });
async function notice(token: string): Promise<Notice> {
  const res = await read(token);
  expect(res.status).toBe(200);
  return (await res.json()) as Notice;
}
async function seenAt(token: string) {
  const db = commonDb(env);
  const awaitHash = await hashSessionToken(token);
  const row = await db.first(
    db.statement((q) => q.selectFrom('sessions').selectAll().where('token_hash', '=', awaitHash)),
  );
  return row?.api_token_seen_at;
}

async function pending() {
  const person = await createLoginPerson({ sessionOverrides: { created_at: ago(3_600_000) } });
  const firstAt = ago(1_800_000);
  const latestAt = ago(900_000);
  await insertApiToken(person.accountId, { name: '最初の発行', scope: 'read', createdAt: firstAt });
  await insertApiToken(person.accountId, { name: '最新の発行', scope: 'write', createdAt: latestAt });
  return { person, firstAt, latestAt };
}

describe('発行の知らせとセッションの独立性', () => {
  test('発行したセッションには出さず、同じアカウントの別セッションには出す', async () => {
    const person = await createLoginPerson();
    const other = await createSessionWithToken(person.accountId, { created_at: ago(60_000) });
    const issued = await post(app, tokenCreate, { token: person.token, body: { name: '手元の CLI', scope: 'read' } });
    expect(issued.status).toBe(200);
    expect(await notice(person.token)).toEqual({ count: 0, latest: null });
    const otherNotice = await notice(other.token);
    expect(otherNotice.count).toBe(1);
    expect(otherNotice.latest).toMatchObject({ name: '手元の CLI', scope: 'read', revoked: false });
    expect(await seenAt(person.token)).toBe(otherNotice.latest?.created_at);
  });

  test('確認したセッションだけで消え、発行側で確認してもほかの端末の未確認を消さない', async () => {
    const { person, latestAt } = await pending();
    const other = await createSessionWithToken(person.accountId, { created_at: ago(3_600_000) });
    const third = await createSessionWithToken(person.accountId, { created_at: ago(3_600_000) });
    expect((await seen(other.token, latestAt)).status).toBe(200);
    expect(await notice(other.token)).toEqual({ count: 0, latest: null });
    expect((await notice(person.token)).count).toBe(2);
    expect((await notice(third.token)).count).toBe(2);
  });

  test('件数と最新の1件だけを返し、別アカウントの行は読み取りも確認も影響しない', async () => {
    const { person, latestAt } = await pending();
    const other = await createLoginPerson({ sessionOverrides: { created_at: ago(3_600_000) } });
    await insertApiToken(other.accountId, { name: '別の人の発行', createdAt: future() });
    expect(await notice(person.token)).toEqual({
      count: 2,
      latest: { name: '最新の発行', scope: 'write', created_at: latestAt, revoked: false },
    });
    expect((await seen(person.token, future())).status).toBe(200);
    expect(await seenAt(person.token)).toBe(latestAt);
    expect((await notice(other.token)).count).toBe(1);
  });

  test('取り消し済みでも未確認の発行を返し、期限切れで行が消えた発行は返さない', async () => {
    const { person, latestAt } = await pending();
    const revoked = await insertApiToken(person.accountId, { name: '取り消した発行', createdAt: ago(300_000) });
    expect((await post(app, tokenRevoke, { token: person.token, body: { id: revoked.hash } })).status).toBe(200);
    expect(await notice(person.token)).toMatchObject({ count: 3, latest: { name: '取り消した発行', revoked: true } });
    const expiredAt = ago(100_000);
    await insertApiToken(person.accountId, { name: '消える発行', createdAt: expiredAt, expiresAt: ago(1_000) });
    await deleteExpiredApiTokens(env, new Date());
    const result = await notice(person.token);
    expect(result.count).toBe(3);
    expect(result.latest?.created_at).not.toBe(expiredAt);
    expect(result.latest?.created_at).not.toBe(latestAt);
  });

  test('確認より前の発行と同じ日時の発行は返さない', async () => {
    const { person, firstAt, latestAt } = await pending();
    expect((await seen(person.token, firstAt)).status).toBe(200);
    expect(await notice(person.token)).toEqual({
      count: 1,
      latest: { name: '最新の発行', scope: 'write', created_at: latestAt, revoked: false },
    });
  });
});

describe('確認日時の上限と単調増加', () => {
  test('未来を送ってもそのアカウントの最新の発行までに丸める', async () => {
    const { person, latestAt } = await pending();
    expect((await seen(person.token, future())).status).toBe(200);
    expect(await seenAt(person.token)).toBe(latestAt);
    expect(await notice(person.token)).toEqual({ count: 0, latest: null });
    await insertApiToken(person.accountId, { name: '確認した後の発行', createdAt: new Date().toISOString() });
    expect((await notice(person.token)).count).toBe(1);
  });

  test('古い確認を後から送っても確認日時は戻らない', async () => {
    const { person, firstAt, latestAt } = await pending();
    expect((await seen(person.token, latestAt)).status).toBe(200);
    expect((await seen(person.token, firstAt)).status).toBe(200);
    expect(await seenAt(person.token)).toBe(latestAt);
    expect(await notice(person.token)).toEqual({ count: 0, latest: null });
  });

  test('表示後に増えた発行は、表示した日時の確認では消えない', async () => {
    const { person, latestAt } = await pending();
    const after = new Date().toISOString();
    await insertApiToken(person.accountId, { name: '表示後の発行', scope: 'read', createdAt: after });
    expect((await seen(person.token, latestAt)).status).toBe(200);
    expect(await notice(person.token)).toEqual({
      count: 1,
      latest: { name: '表示後の発行', scope: 'read', created_at: after, revoked: false },
    });
  });

  test('発行が無いとき未来の確認で先の発行まで消さない', async () => {
    const person = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000) } });
    expect((await seen(person.token, future())).status).toBe(200);
    await insertApiToken(person.accountId, { createdAt: new Date().toISOString() });
    expect((await notice(person.token)).count).toBe(1);
  });

  test.each(['not-a-date', '2026-11-04', '2026-11-04T00:00:00Z', '2026-11-04T00:00:00.000+09:00'])(
    '正規化されていない日時 %s は400',
    async (created_at) => {
      const person = await createLoginPerson();
      const result = await seen(person.token, created_at);
      expect(result.status).toBe(400);
      expect(await errorCodeOf(result)).toBe('invalid_input');
    },
  );
});

describe('新しいログインと再認証への引き継ぎ', () => {
  test('有効な他セッションのうち最も古い確認を引き継ぐ', async () => {
    const { person, firstAt } = await pending();
    const db = commonDb(env);
    const originalHash = await hashSessionToken(person.token);
    const original = await db.first(
      db.statement((q) => q.selectFrom('sessions').select('created_at').where('token_hash', '=', originalHash)),
    );
    const checked = await createSessionWithToken(person.accountId, { created_at: ago(3_000_000) });
    expect((await seen(checked.token, firstAt)).status).toBe(200);
    const token = await createSession(testEnv, person.accountId, new Date(), undefined);
    expect((await notice(token)).count).toBe(2);
    expect(await seenAt(token)).toBe(original?.created_at);
  });

  test('置き換えるセッションが最も古い確認でも、消す前に引き継ぐ', async () => {
    const { person } = await pending();
    const later = await createSessionWithToken(person.accountId, { created_at: ago(600_000) });
    const token = await createSession(testEnv, person.accountId, new Date(), person.token);
    expect((await read(person.token)).status).toBe(401);
    expect((await notice(token)).count).toBe(2);
    expect((await notice(later.token)).count).toBe(0);
  });

  test('他セッションが無い新ログインには過去の発行を返さない', async () => {
    const account = await createAccount();
    await insertApiToken(account.id, { createdAt: ago(60_000) });
    const token = await createSession(testEnv, account.id, new Date(), undefined);
    expect(await notice(token)).toEqual({ count: 0, latest: null });
  });

  test('期限切れのセッションの古い確認と別アカウントの古い確認は引き継がない', async () => {
    const { person, latestAt } = await pending();
    expect((await seen(person.token, latestAt)).status).toBe(200);
    await createSessionWithToken(person.accountId, { created_at: ago(7_200_000), expires_at: ago(1_000) });
    await createLoginPerson({ sessionOverrides: { created_at: ago(7_200_000) } });
    const token = await createSession(testEnv, person.accountId, new Date(), undefined);
    expect(await notice(token)).toEqual({ count: 0, latest: null });
    expect(await seenAt(token)).toBe(latestAt);
  });

  test('セッションを渡さない issueApiTokenWith の呼び出しも使える', async () => {
    const person = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000) } });
    const issued = await issueApiTokenWith(commonDb(env), {
      accountId: person.accountId,
      name: 'seed と同じ呼び口',
      scope: 'read',
      now: new Date(),
    });
    expect(issued.raw).toMatch(/^sgp_/);
    expect((await notice(person.token)).count).toBe(1);
  });
});

describe('Cookie に限る操作', () => {
  test.each(['read', 'write'] as const)('範囲 %s の API トークンでは2つとも403 forbidden', async (scope) => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { scope });
    for (const definition of [tokenNotice, tokenNoticeSeen]) {
      const result = await post(app, definition, {
        bearer: raw,
        origin: null,
        body: { created_at: new Date().toISOString() },
      });
      expect(result.status).toBe(403);
      expect(await errorCodeOf(result)).toBe('forbidden');
    }
  });
});
