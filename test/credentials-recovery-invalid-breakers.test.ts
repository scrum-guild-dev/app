// 不正日時の扱いと、新しく足した事前確認の間の競合を崩す検査。
import { expect, test } from 'vitest';
import { credentialsRevokeAll } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { insertApiToken, tokenRow } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const future = () => new Date(Date.now() + 86400000).toISOString();

test('SQLite の日時の下限でも、不正日時の他セッションは最古として消す', async () => {
  const owner = await createLoginPerson({ sessionOverrides: { created_at: '-4713-11-24T12:00:00Z' } });
  await createSessionWithToken(owner.accountId, { created_at: 'not-a-date', expires_at: future() });
  const newer = await createSessionWithToken(owner.accountId, { expires_at: future() });

  const response = await post(app, credentialsRevokeAll, { token: owner.token });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
  expect((await sessionRowsOf(owner.accountId)).map((row) => row.token_hash).sort()).toEqual(
    [await hashSessionToken(owner.token), newer.row.token_hash].sort(),
  );
});

test('作成日時を確認した後に今の行が消えても、他セッションとトークンは変えず200・件数0', async () => {
  const owner = await createLoginPerson();
  const currentHash = await hashSessionToken(owner.token);
  const current = (await sessionRowsOf(owner.accountId)).find((row) => row.token_hash === currentHash)!;
  const other = await createSessionWithToken(owner.accountId, { created_at: current.created_at, expires_at: future() });
  const token = await insertApiToken(owner.accountId, { expiresAt: future() });
  const beforeToken = await tokenRow(token.hash);
  let interrupted = false;
  const hooked = envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (interrupted || !sql.includes('julianday("created_at")')) return;
      interrupted = true;
      const db = commonDb(testEnv);
      await db.batch([
        db.statement((q) =>
          q.deleteFrom('sessions').where('account_id', '=', owner.accountId).where('token_hash', '=', currentHash),
        ),
      ]);
    },
  });

  const response = await post(app, credentialsRevokeAll, { token: owner.token, env: hooked });

  expect(interrupted).toBe(true);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
  expect((await sessionRowsOf(owner.accountId)).map((row) => row.token_hash)).toEqual([other.row.token_hash]);
  expect(await tokenRow(token.hash)).toEqual(beforeToken);
});
