// 旧版が NULL の確認列と一緒に残した created_at も、同じ瞬間の UTC として比べる。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { createSession, hashSessionToken } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { tokenNotice, tokenNoticeSeen } from '../src/shared/operations/session/index.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const utc = (ms: number) => new Date(Date.now() - ms).toISOString();
const asJst = (value: string) => new Date(Date.parse(value) + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');

async function confirmation(token: string) {
  const db = commonDb(env);
  const hash = await hashSessionToken(token);
  return (
    await db.first(
      db.statement((q) => q.selectFrom('sessions').select('api_token_seen_at').where('token_hash', '=', hash)),
    )
  )?.api_token_seen_at;
}

for (const spelling of ['offset', 'seconds', 'invalid'] as const) {
  test(`NULL の確認日時と created_at ${spelling} でも未確認を失わず確認・引継ぎできる`, async () => {
    const created = utc(60 * 60 * 1000);
    const raw =
      spelling === 'offset' ? asJst(created) : spelling === 'seconds' ? created.replace(/\.\d{3}Z$/, 'Z') : 'garbage';
    const person = await createLoginPerson({ sessionOverrides: { created_at: raw } });
    const tokenAt = utc(30 * 60 * 1000);
    await insertApiToken(person.accountId, { createdAt: tokenAt });
    const read = await post(app, tokenNotice, { token: person.token });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { count: number }).count).toBe(1);
    const replacement = await createSession(testEnv, person.accountId, new Date(), person.token);
    const inherited = await post(app, tokenNotice, { token: replacement });
    expect(inherited.status).toBe(200);
    expect(((await inherited.json()) as { count: number }).count).toBe(1);
    const result = await post(app, tokenNoticeSeen, { token: replacement, body: { created_at: tokenAt } });
    expect(result.status).toBe(200);
    expect(await confirmation(replacement)).toBe(tokenAt);
  });
}
