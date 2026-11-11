// #1144 / PR #1157: 読めない作成日時で、盗難セッションが全失効を免れない。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { credentialsRevokeAll } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const future = () => new Date(Date.now() + 86400000).toISOString();
const unreadableDates = ['not-a-date', '', '+010000-01-01T00:00:00.000Z'];

async function expectSqliteUnreadable(value: string) {
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) => q.selectNoFrom((eb) => eb.fn<number | null>('julianday', [eb.val(value)]).as('day'))),
  );
  expect(row!.day).toBeNull();
  // JS が読める日時でも、SQL の比較ができなければ無効な作成日時として扱う。
  if (value.startsWith('+010000')) expect(Number.isFinite(Date.parse(value))).toBe(true);
}

test.each(unreadableDates)('他のセッションの作成日時が読めない場合は最古として締め出す: %j', async (createdAt) => {
  await expectSqliteUnreadable(createdAt);
  const now = Date.now();
  const currentAt = new Date(now - 86400000).toISOString();
  // 10分を過ぎた有効な作成日時でも実行できる。一般の再認証は導入しない。
  const owner = await createLoginPerson({
    sessionOverrides: { created_at: currentAt, last_used_at: new Date(now).toISOString() },
  });
  await createSessionWithToken(owner.accountId, { created_at: createdAt, expires_at: future() });
  const newer = await createSessionWithToken(owner.accountId, {
    created_at: new Date(now).toISOString(),
    expires_at: future(),
  });
  const bystander = await createLoginPerson({ sessionOverrides: { created_at: createdAt } });
  const theirsBefore = await sessionRowsOf(bystander.accountId);
  const mineToken = await insertApiToken(owner.accountId, { expiresAt: future() });
  const theirToken = await insertApiToken(bystander.accountId, { expiresAt: future() });
  const theirTokenBefore = await tokenRow(theirToken.hash);

  const response = await post(app, credentialsRevokeAll, { token: owner.token });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 1 });
  expect((await sessionRowsOf(owner.accountId)).map((row) => row.token_hash).sort()).toEqual(
    [await hashSessionToken(owner.token), newer.row.token_hash].sort(),
  );
  expect((await tokenRow(mineToken.hash))!.revoked_at).not.toBeNull();
  expect(await sessionRowsOf(bystander.accountId)).toEqual(theirsBefore);
  expect(await tokenRow(theirToken.hash)).toEqual(theirTokenBefore);
});

test.each(unreadableDates)(
  '実行セッションの作成日時が読めない場合は401で全失効せず、他セッションとトークンを保持する: %j',
  async (createdAt) => {
    await expectSqliteUnreadable(createdAt);
    const now = new Date().toISOString();
    const owner = await createLoginPerson({
      sessionOverrides: { created_at: createdAt, last_used_at: now, expires_at: future() },
    });
    await createSessionWithToken(owner.accountId, { created_at: '2026-01-01T00:00:00.000Z', expires_at: future() });
    await createSessionWithToken(owner.accountId, { created_at: now, expires_at: future() });
    await insertApiToken(owner.accountId, { expiresAt: future() });
    await insertApiToken(owner.accountId, { expiresAt: future(), revokedAt: '2026-01-01T00:00:00.000Z' });
    const sessionsBefore = await sessionRowsOf(owner.accountId);
    const tokensBefore = await tokenRowsOf(owner.accountId);

    const response = await post(app, credentialsRevokeAll, { token: owner.token });

    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
    expect(await sessionRowsOf(owner.accountId)).toEqual(sessionsBefore);
    expect(await tokenRowsOf(owner.accountId)).toEqual(tokensBefore);
  },
);
