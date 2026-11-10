// 発行の直前・直後にセッションが消える順序と、拒否した発行の副作用を確かめる。
import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { issueApiTokenWith, revokeAllApiTokensStatement } from '../src/server/auth/api-token.ts';
import { deleteOtherSessionsStatement } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { createAccount, createSession } from './factories.ts';
import { tokenRowsOf } from './operations/api-token.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const BEFORE = '2026-11-03T11:59:00.000Z';
const inputFor = (accountId: string, sessionTokenHash: string) => ({
  accountId,
  sessionTokenHash,
  name: '競合の確かめ',
  scope: 'read' as const,
  now: NOW,
});

afterEach(() => vi.restoreAllMocks());

test('発行バッチを送る直前に全失効しても、読み取り済みのセッションからトークンを残さない', async () => {
  const account = await createAccount();
  const current = await createSession(account.id);
  const stale = await createSession(account.id, { created_at: current.created_at });
  const db = commonDb(env);
  const revokeDb = commonDb(env);
  const batch = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
    await revokeDb.batch([
      deleteOtherSessionsStatement(revokeDb, account.id, current.token_hash),
      revokeAllApiTokensStatement(revokeDb, account.id, NOW),
    ]);
    return batch(statements);
  });

  await expect(issueApiTokenWith(db, inputFor(account.id, stale.token_hash))).rejects.toMatchObject({
    status: 401,
    code: 'unauthenticated',
  });
  expect(await tokenRowsOf(account.id)).toHaveLength(0);
});

test('発行が成功した直後に全失効しても、成功した発行を401へ置き換えず、トークンは取り消される', async () => {
  const account = await createAccount();
  const current = await createSession(account.id);
  const stale = await createSession(account.id, { created_at: current.created_at });
  const db = commonDb(env);
  const revokeDb = commonDb(env);
  const batch = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
    const result = await batch(statements);
    await revokeDb.batch([
      deleteOtherSessionsStatement(revokeDb, account.id, current.token_hash),
      revokeAllApiTokensStatement(revokeDb, account.id, NOW),
    ]);
    return result;
  });

  const issued = await issueApiTokenWith(db, inputFor(account.id, stale.token_hash));
  expect(await tokenRowsOf(account.id)).toMatchObject([
    { token_hash: issued.tokenHash, revoked_at: NOW.toISOString() },
  ]);
});

test('期限切れで発行を拒否したとき、残ったセッションの発行確認日時を進めない', async () => {
  const account = await createAccount();
  const session = await createSession(account.id, {
    created_at: BEFORE,
    expires_at: NOW.toISOString(),
    api_token_seen_at: BEFORE,
  });
  const db = commonDb(env);

  await expect(issueApiTokenWith(db, inputFor(account.id, session.token_hash))).rejects.toMatchObject({
    status: 401,
    code: 'unauthenticated',
  });
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('sessions').select('api_token_seen_at').where('token_hash', '=', session.token_hash),
    ),
  );
  expect(row?.api_token_seen_at).toBe(BEFORE);
  expect(await tokenRowsOf(account.id)).toHaveLength(0);
});
