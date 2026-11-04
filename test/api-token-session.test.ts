// 読み取った後に失効したセッションから、API トークンを残せないことを Workers の D1 で確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { issueApiTokenWith } from '../src/server/auth/api-token.ts';
import { deleteOtherSessionsStatement } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { createAccount, createSession } from './factories.ts';
import { insertApiToken, tokenRowsOf } from './operations/api-token.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const db = commonDb(env);
const inputFor = (accountId: string, sessionTokenHash?: string) => ({
  accountId,
  name: '手元の CLI',
  scope: 'read' as const,
  now: NOW,
  ...(sessionTokenHash === undefined ? {} : { sessionTokenHash }),
});

describe('API トークン発行時のセッションの再確認', () => {
  test('全失効で行を消したセッションからは401となり、トークンを作らない', async () => {
    const account = await createAccount();
    const current = await createSession(account.id);
    const stolen = await createSession(account.id);
    const input = inputFor(account.id, stolen.token_hash);
    await db.batch([deleteOtherSessionsStatement(db, account.id, current.token_hash)]);

    await expect(issueApiTokenWith(db, input)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await tokenRowsOf(account.id)).toHaveLength(0);
  });

  test.each([-1, 0])('期限が基準時刻から %i ms のセッションは401で、トークンを作らない', async (offset) => {
    const account = await createAccount();
    const session = await createSession(account.id, { expires_at: new Date(NOW.getTime() + offset).toISOString() });
    const input = inputFor(account.id, session.token_hash);

    await expect(issueApiTokenWith(db, input)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await tokenRowsOf(account.id)).toHaveLength(0);
  });

  test('期限内の自分のセッションは発行できる', async () => {
    const account = await createAccount();
    const session = await createSession(account.id, { expires_at: new Date(NOW.getTime() + 1).toISOString() });
    const issued = await issueApiTokenWith(db, inputFor(account.id, session.token_hash));

    expect(issued.raw).toMatch(/^sgp_/);
    expect(await tokenRowsOf(account.id)).toMatchObject([{ token_hash: issued.tokenHash, account_id: account.id }]);
  });

  test('他人のセッションのハッシュでは発行できない', async () => {
    const account = await createAccount();
    const other = await createAccount();
    const session = await createSession(other.id);
    const input = inputFor(account.id, session.token_hash);

    await expect(issueApiTokenWith(db, input)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await tokenRowsOf(account.id)).toHaveLength(0);
  });

  test('有効なセッションでも上限20件なら409のlimitになる', async () => {
    const account = await createAccount();
    const session = await createSession(account.id);
    for (let i = 0; i < 20; i++) await insertApiToken(account.id, { expiresAt: '2026-12-01T00:00:00.000Z' });

    await expect(issueApiTokenWith(db, inputFor(account.id, session.token_hash))).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      details: { reason: 'limit' },
    });
    expect(await tokenRowsOf(account.id)).toHaveLength(20);
  });

  test('上限に達していても消えたセッションは409と取り違えず401になる', async () => {
    const account = await createAccount();
    const current = await createSession(account.id);
    const stolen = await createSession(account.id);
    for (let i = 0; i < 20; i++) await insertApiToken(account.id, { expiresAt: '2026-12-01T00:00:00.000Z' });
    await db.batch([deleteOtherSessionsStatement(db, account.id, current.token_hash)]);

    await expect(issueApiTokenWith(db, inputFor(account.id, stolen.token_hash))).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(await tokenRowsOf(account.id)).toHaveLength(20);
  });

  test('セッションを渡さないseed相当の呼び出しも発行できる', async () => {
    const account = await createAccount();
    const issued = await issueApiTokenWith(db, inputFor(account.id));

    expect(await tokenRowsOf(account.id)).toMatchObject([{ token_hash: issued.tokenHash, account_id: account.id }]);
  });
});
