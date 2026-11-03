// SQLite の特殊な日時表記を、旧セッションの確認済み日時として扱わない。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { createSession, hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { tokenNotice, tokenNoticeSeen } from '../src/shared/operations/session/index.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
// Julian day の 2451545 は2000年になる。実在する過去の発行も、その解釈で隠れないことを確かめる。
const issuedAt = '1999-12-31T23:59:00.000Z';

async function fixture(created_at: string) {
  const person = await createLoginPerson({ sessionOverrides: { created_at, api_token_seen_at: null } });
  await insertApiToken(person.accountId, { name: '未確認の発行', createdAt: issuedAt });
  return person;
}

async function expectPending(token: string) {
  const res = await post(app, tokenNotice, { token });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ count: 1, latest: { name: '未確認の発行', created_at: issuedAt } });
}

for (const createdAt of ['0', 'now', '2451545']) {
  describe(`旧セッションの created_at が SQLite の特殊値 ${createdAt}`, () => {
    test('NULL の確認記録から未確認の発行を隠さない', async () => {
      const person = await fixture(createdAt);
      await expectPending(person.token);
    });

    test('置き換えは CHECK 例外を出さず、未確認を引き継ぐ', async () => {
      const person = await fixture(createdAt);
      const replacement = await createSession(testEnv, person.accountId, new Date(), person.token);
      expect((await post(app, tokenNotice, { token: person.token })).status).toBe(401);
      await expectPending(replacement);
    });

    test('確認しても CHECK 例外を出さず、その発行まで記録できる', async () => {
      const person = await fixture(createdAt);
      const res = await post(app, tokenNoticeSeen, { token: person.token, body: { created_at: issuedAt } });
      expect(res.status).toBe(200);
      const db = commonDb(env);
      const hash = await hashSessionToken(person.token);
      const row = await db.first(
        db.statement((q) => q.selectFrom('sessions').select('api_token_seen_at').where('token_hash', '=', hash)),
      );
      expect(row?.api_token_seen_at).toBe(issuedAt);
      const read = await post(app, tokenNotice, { token: person.token });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ count: 0, latest: null });
    });
  });
}
