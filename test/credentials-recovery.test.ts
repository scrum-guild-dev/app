// #1144: 古い盗難 Cookie の全失効で、ログインし直した本人が締め出され続けない。
import { describe, expect, test } from 'vitest';
import { credentialsRevokeAll, me } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { createSession, hashSessionToken } from '../src/server/auth/session.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { insertApiToken, tokenRow } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const future = () => new Date(Date.now() + 86400000).toISOString();
const revokeAll = (token: string, env = testEnv) => post(app, credentialsRevokeAll, { token, env });
const callMe = (token: string) => post(app, me, { token });
const hashesOf = async (accountId: string) => (await sessionRowsOf(accountId)).map((row) => row.token_hash).sort();

describe('全失効の作成時刻の境界', () => {
  test('同時刻以前の他セッションを消し、1ミリ秒後のセッションと他アカウントは残す。トークンは作成時刻によらず取り消す', async () => {
    const at = Date.now() - 1000;
    const owner = await createLoginPerson({ sessionOverrides: { created_at: new Date(at).toISOString() } });
    const older = await createSessionWithToken(owner.accountId, { created_at: new Date(at - 1).toISOString() });
    const same = await createSessionWithToken(owner.accountId, { created_at: new Date(at).toISOString() });
    const newer = await createSessionWithToken(owner.accountId, { created_at: new Date(at + 1).toISOString() });
    const bystander = await createLoginPerson();
    const before = await sessionRowsOf(bystander.accountId);
    const mineToken = await insertApiToken(owner.accountId, {
      createdAt: new Date(at + 1).toISOString(),
      expiresAt: future(),
    });
    const theirToken = await insertApiToken(bystander.accountId, { expiresAt: future() });

    const res = await revokeAll(owner.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 2, revoked_tokens: 1 });
    expect(await hashesOf(owner.accountId)).toEqual([await hashSessionToken(owner.token), newer.row.token_hash].sort());
    expect((await callMe(older.token)).status).toBe(401);
    expect((await callMe(same.token)).status).toBe(401);
    expect((await callMe(newer.token)).status).toBe(200);
    expect((await tokenRow(mineToken.hash))!.revoked_at).not.toBeNull();
    expect((await tokenRow(theirToken.hash))!.revoked_at).toBeNull();
    expect(await sessionRowsOf(bystander.accountId)).toEqual(before);
  });

  test('古い側が先に全失効しても新しい側は残り、新しい側が次に古い側を締め出せる', async () => {
    const at = Date.now() - 1000;
    const old = await createLoginPerson({ sessionOverrides: { created_at: new Date(at).toISOString() } });
    const newer = await createSessionWithToken(old.accountId, { created_at: new Date(at + 1).toISOString() });
    expect(await (await revokeAll(old.token)).json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect((await callMe(newer.token)).status).toBe(200);
    expect(await (await revokeAll(newer.token)).json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
    expect((await callMe(old.token)).status).toBe(401);
    expect(await hashesOf(old.accountId)).toEqual([newer.row.token_hash]);
  });
});

test('盗難 Cookie が本人を締め出した後も全失効を繰り返すが、本人は実際の再ログインで回復して盗難 Cookie を締め出せる', async () => {
  const oldAt = new Date(Date.now() - 86400000).toISOString();
  const owner = await createLoginPerson({ sessionOverrides: { created_at: oldAt } });
  const stolen = await createSessionWithToken(owner.accountId, { created_at: oldAt });
  expect(await (await revokeAll(stolen.token)).json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
  expect((await callMe(owner.token)).status).toBe(401);

  const fresh = await createSession(testEnv, owner.accountId, new Date(), owner.token);
  const freshHash = await hashSessionToken(fresh);
  expect(
    Date.parse((await sessionRowsOf(owner.accountId)).find((row) => row.token_hash === freshHash)!.created_at),
  ).toBeGreaterThan(Date.parse(oldAt));
  // 認証が済んでから本人が全失効を書き込むまでの間に、攻撃者を決定的に割り込ませる。
  let interrupted = false;
  const attacks: { status: number; body: unknown; ownerStatus: number }[] = [];
  const hooked = envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (interrupted || !sql.includes('"account_consents"')) return;
      interrupted = true;
      for (let i = 0; i < 3; i++) {
        const attack = await revokeAll(stolen.token);
        attacks.push({ status: attack.status, body: await attack.json(), ownerStatus: (await callMe(fresh)).status });
      }
    },
  });
  const recovered = await revokeAll(fresh, hooked);
  expect(interrupted).toBe(true);
  expect(attacks).toEqual(
    Array.from({ length: 3 }, () => ({
      status: 200,
      body: { revoked_sessions: 0, revoked_tokens: 0 },
      ownerStatus: 200,
    })),
  );
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
  expect(await hashesOf(owner.accountId)).toEqual([freshHash]);
  expect((await callMe(stolen.token)).status).toBe(401);
  expect((await revokeAll(stolen.token)).status).toBe(401);
  expect((await callMe(fresh)).status).toBe(200);
});
