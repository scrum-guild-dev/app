// #768（全失効の件数を期限内の行だけに数える）を崩す検査。test/credentials-revoke-all.test.ts と
// test/credentials-revoke-all-breakers.test.ts と重ならない手口だけ置く（認証と書き込みの間に時刻が進む、
// 認証の判定との一致、seed の strftime の形、文の RETURNING と changes の一致、認証の後に足された行）
/* eslint-disable db-entry/guard -- seed と同じ SQL の形で行を直に作るため */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { credentialsRevokeAll, me } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { revokeAllApiTokensStatement } from '../src/server/auth/api-token.ts';
import { hashSessionToken, deleteOtherSessionsStatement } from '../src/server/auth/session.ts';
import { sha256Hex } from '../src/server/auth/tokens.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { insertApiToken, rawApiToken, tokenRow } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days = 30) => new Date(Date.now() + days * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

type Counts = { revoked_sessions: number; revoked_tokens: number };
const revokeAll = (token: string, hookedEnv?: Env) =>
  post(app, credentialsRevokeAll, hookedEnv === undefined ? { token } : { token, env: hookedEnv });

// 認証と同意の確かめを終え、書き込みの batch() を送る前に between を await する env
function pausedAfterAuth(between: () => Promise<void> | void) {
  const state = { ran: false };
  const hooked = envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (state.ran || !sql.includes('"account_consents"')) return;
      state.ran = true;
      await between();
    },
  });
  return { env: hooked, state };
}

describe('時刻を止めて確かめる', () => {
  let NOW = new Date();
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  beforeEach(() => {
    NOW = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('認証の後・書き込みの前に時刻が 5 ミリ秒進むと、境目は書き込みの時刻（revoked_at と同じ値）で決まる', async () => {
    const person = await createLoginPerson({ sessionOverrides: { expires_at: at(DAY_MS), last_used_at: at(0) } });
    // 認証の時刻（NOW）では期限内、書き込みの時刻（NOW+5）では切れているか、ちょうど切れる行
    await createSessionWithToken(person.accountId, { expires_at: at(3) });
    await createSessionWithToken(person.accountId, { expires_at: at(5) });
    await createSessionWithToken(person.accountId, { expires_at: at(6) });
    const t3 = await insertApiToken(person.accountId, { expiresAt: at(3) });
    const t5 = await insertApiToken(person.accountId, { expiresAt: at(5) });
    const t6 = await insertApiToken(person.accountId, { expiresAt: at(6) });
    const paused = pausedAfterAuth(() => {
      vi.setSystemTime(new Date(NOW.getTime() + 5));
    });

    const res = await revokeAll(person.token, paused.env);

    expect(paused.state.ran).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 1 });
    for (const token of [t3, t5, t6]) expect((await tokenRow(token.hash))!.revoked_at).toBe(at(5));
    expect((await sessionRowsOf(person.accountId)).map((row) => row.token_hash)).toEqual([
      await hashSessionToken(person.token),
    ]);
  });

  test('数えたトークンの数は、同じ時刻にそのトークンで認証して通った数と一致する（境目の前後 2 ミリ秒）', async () => {
    const person = await createLoginPerson({ sessionOverrides: { expires_at: at(DAY_MS), last_used_at: at(0) } });
    const offsets = [-2, -1, 0, 1, 2];
    const tokens = await Promise.all(offsets.map((ms) => insertApiToken(person.accountId, { expiresAt: at(ms) })));
    const statuses = [];
    for (const token of tokens) statuses.push((await post(app, me, { bearer: token.raw, origin: null })).status);
    expect(statuses).toEqual([401, 401, 401, 200, 200]);
    // 認証が書いた last_used_at は期限を変えない。取り消し済みにもしていない
    for (const token of tokens) expect((await tokenRow(token.hash))!.revoked_at).toBeNull();

    const res = await revokeAll(person.token);
    expect(await res.json()).toEqual({
      revoked_sessions: 0,
      revoked_tokens: statuses.filter((status) => status === 200).length,
    });
  });
});

describe('seed と同じ SQL の strftime で書いた expires_at', () => {
  test("strftime('%Y-%m-%dT%H:%M:%fZ') の行も、toISOString の行と同じ形で比べ、期限内だけを数える", async () => {
    const person = await createLoginPerson();
    const insert = async (modifier: string) => {
      const hash = await sha256Hex(rawApiToken());
      await env.DB.prepare(
        `insert into api_tokens (token_hash, account_id, name, scope, created_at, last_used_at, expires_at, revoked_at)
         values (?, ?, 'seed の形', 'write', '2026-10-20T00:00:00.000Z', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?), NULL)`,
      )
        .bind(hash, person.accountId, modifier)
        .run();
      return hash;
    };
    const live = await insert('+90 days');
    const expired = await insert('-1 seconds');
    expect((await tokenRow(live))!.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    expect(await (await revokeAll(person.token)).json()).toEqual({ revoked_sessions: 0, revoked_tokens: 1 });
    expect((await tokenRow(live))!.revoked_at).not.toBeNull();
    expect((await tokenRow(expired))!.revoked_at).not.toBeNull();
  });
});

describe('文の RETURNING', () => {
  const db = () => commonDb(env);

  test('2文の rows の数は changes と同じで、行は expires_at だけを持ち、期限切れの行も返す', async () => {
    const person = await createLoginPerson();
    const liveSession = future();
    const deadSession = past();
    await createSessionWithToken(person.accountId, { expires_at: liveSession });
    await createSessionWithToken(person.accountId, { expires_at: deadSession });
    const liveToken = future(7);
    const deadToken = past();
    await insertApiToken(person.accountId, { expiresAt: liveToken });
    await insertApiToken(person.accountId, { expiresAt: deadToken });
    await insertApiToken(person.accountId, { expiresAt: future(), revokedAt: '2026-10-25T00:00:00.000Z' });
    const current = await hashSessionToken(person.token);

    const entry = db();
    const [sessions, tokens] = await entry.batch([
      deleteOtherSessionsStatement(entry, person.accountId, current),
      revokeAllApiTokensStatement(entry, person.accountId, new Date(), current),
    ]);

    expect(sessions.changes).toBe(2);
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows.map((row) => Object.keys(row))).toEqual([['expires_at'], ['expires_at']]);
    expect(sessions.rows.map((row) => row.expires_at).sort()).toEqual([deadSession, liveSession].sort());
    expect(tokens.changes).toBe(2);
    expect(tokens.rows).toHaveLength(2);
    expect(tokens.rows.map((row) => row.expires_at).sort()).toEqual([deadToken, liveToken].sort());
  });

  test('今のセッションの行が無いと、2文とも rows は空の配列で changes は 0（undefined にならない）', async () => {
    const person = await createLoginPerson();
    await createSessionWithToken(person.accountId, { expires_at: future() });
    await insertApiToken(person.accountId, { expiresAt: future() });
    const entry = db();
    const [sessions, tokens] = await entry.batch([
      deleteOtherSessionsStatement(entry, person.accountId, 'f'.repeat(64)),
      revokeAllApiTokensStatement(entry, person.accountId, new Date(), 'f'.repeat(64)),
    ]);
    expect(sessions).toEqual({ rows: [], changes: 0 });
    expect(tokens).toEqual({ rows: [], changes: 0 });
  });

  test('4つ目を省いた形も、取り消した行の expires_at を返す（取り消し済みの行は返さない）', async () => {
    const person = await createLoginPerson();
    const expiresAt = future(3);
    await insertApiToken(person.accountId, { expiresAt });
    await insertApiToken(person.accountId, { expiresAt: future(), revokedAt: '2026-10-25T00:00:00.000Z' });
    const entry = db();
    const [tokens] = await entry.batch([revokeAllApiTokensStatement(entry, person.accountId, new Date())]);
    expect(tokens).toEqual({ rows: [{ expires_at: expiresAt }], changes: 1 });
  });
});

describe('認証の後に足された行（勝つ側）', () => {
  test('認証の後・書き込みの前に足した期限内と期限切れの行も消え・取り消され、件数には書いた期限内の行だけが入る', async () => {
    const person = await createLoginPerson();
    await createSessionWithToken(person.accountId, { expires_at: future() });
    let added: { live: string; dead: string } | undefined;
    const paused = pausedAfterAuth(async () => {
      await createSessionWithToken(person.accountId, { expires_at: future() });
      await createSessionWithToken(person.accountId, { expires_at: past() });
      added = {
        live: (await insertApiToken(person.accountId, { expiresAt: future() })).hash,
        dead: (await insertApiToken(person.accountId, { expiresAt: past() })).hash,
      };
    });

    const res = await revokeAll(person.token, paused.env);

    expect(paused.state.ran).toBe(true);
    expect(res.status).toBe(200);
    expect((await res.json()) as Counts).toEqual({ revoked_sessions: 2, revoked_tokens: 1 });
    expect(await sessionRowsOf(person.accountId)).toHaveLength(1);
    expect((await tokenRow(added!.live))!.revoked_at).not.toBeNull();
    expect((await tokenRow(added!.dead))!.revoked_at).not.toBeNull();
  });
});
