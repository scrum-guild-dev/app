// #716: 発行失敗、異なるアカウント、遅延・同時要求の境界で確認記録を崩す。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { issueApiTokenWith } from '../src/server/auth/api-token.ts';
import { createSession, hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { API_TOKEN_MAX_ACTIVE } from '../src/shared/api-token.ts';
import { tokenCreate, tokenNotice, tokenNoticeSeen } from '../src/shared/operations/session/index.ts';
import { createAccount, createSessionWithToken } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
async function session(token: string) {
  const hash = await hashSessionToken(token);
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q.selectFrom('sessions').select(['created_at', 'api_token_seen_at']).where('token_hash', '=', hash),
    ),
  );
}
async function notice(token: string) {
  const response = await post(app, tokenNotice, { token });
  expect(response.status).toBe(200);
  return response.json<{ count: number; latest: { name: string; created_at: string } | null }>();
}

test('上限で発行が失敗してもNULLの確認記録を進めず、他端末の発行を隠さない', async () => {
  const person = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000), api_token_seen_at: null } });
  for (let i = 0; i < API_TOKEN_MAX_ACTIVE; i++) {
    await insertApiToken(person.accountId, { createdAt: ago(30_000), name: `未確認${i}` });
  }
  const response = await post(app, tokenCreate, { token: person.token, body: { name: '上限超過', scope: 'write' } });
  expect(response.status).toBe(409);
  expect((await session(person.token))?.api_token_seen_at).toBeNull();
  expect((await notice(person.token)).count).toBe(API_TOKEN_MAX_ACTIVE);
});

test('発行に別アカウントのセッションを渡しても、その確認記録を変更しない', async () => {
  const person = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000) } });
  const foreign = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000) } });
  const before = await session(foreign.token);
  await issueApiTokenWith(commonDb(env), {
    accountId: person.accountId,
    name: '別アカウントのハッシュ',
    scope: 'read',
    now: new Date(),
    sessionTokenHash: await hashSessionToken(foreign.token),
  });
  expect(await session(foreign.token)).toEqual(before);
  expect((await notice(foreign.token)).count).toBe(0);
  expect((await notice(person.token)).count).toBe(1);
});

test('新しい確認より古い発行要求が遅れて完了しても、確認日時を戻さない', async () => {
  const latest = ago(10_000);
  const person = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000), api_token_seen_at: latest } });
  await issueApiTokenWith(commonDb(env), {
    accountId: person.accountId,
    name: '遅れた発行',
    scope: 'read',
    now: new Date(ago(30_000)),
    sessionTokenHash: await hashSessionToken(person.token),
  });
  expect((await session(person.token))?.api_token_seen_at).toBe(latest);
  expect((await notice(person.token)).count).toBe(0);
});

test('確認日時が異なる要求を同時に送っても、最後は最新の発行まで進む', async () => {
  const person = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000) } });
  const first = ago(30_000);
  const latest = ago(10_000);
  await insertApiToken(person.accountId, { createdAt: first });
  await insertApiToken(person.accountId, { createdAt: latest });
  const responses = await Promise.all(
    [latest, first, new Date(Date.now() + 60_000).toISOString()].map((created_at) =>
      post(app, tokenNoticeSeen, { token: person.token, body: { created_at } }),
    ),
  );
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
  expect((await session(person.token))?.api_token_seen_at).toBe(latest);
  expect((await notice(person.token)).count).toBe(0);
});

test('expires_atが今と同じセッションは引き継ぎ元にせず、過去の発行を表示しない', async () => {
  const account = await createAccount();
  const now = new Date();
  await createSessionWithToken(account.id, { created_at: ago(60_000), expires_at: now.toISOString() });
  await insertApiToken(account.id, { createdAt: ago(30_000) });
  const token = await createSession(testEnv, account.id, now, undefined);
  const created = await session(token);
  expect(created?.api_token_seen_at).toBe(created?.created_at);
  expect(await notice(token)).toEqual({ count: 0, latest: null });
});

test('期限が来ても掃除で行が消えるまでは、未確認の発行を知らせる', async () => {
  const person = await createLoginPerson({ sessionOverrides: { created_at: ago(60_000) } });
  const at = ago(30_000);
  await insertApiToken(person.accountId, { name: '掃除前の期限切れ', createdAt: at, expiresAt: ago(1_000) });
  expect(await notice(person.token)).toMatchObject({ count: 1, latest: { name: '掃除前の期限切れ', created_at: at } });
});
