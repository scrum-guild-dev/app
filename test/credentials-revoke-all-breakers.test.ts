// credentials-revoke-all を崩す検査。test/credentials-revoke-all.test.ts と重ならない手口だけ置く（並行、大きな件数、
// 似たハッシュ、取り消しの日時の形、別のアカウントの似た行）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { credentialsRevokeAll, logout, me } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { revokeAllApiTokensStatement } from '../src/server/auth/api-token.ts';
import { hashSessionToken, deleteOtherSessionsOf, deleteOtherSessionsStatement } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

type Counts = { revoked_sessions: number; revoked_tokens: number };
const revokeAll = (token: string) => post(app, credentialsRevokeAll, { token });
const callMe = (token: string) => post(app, me, { token });

describe('並行', () => {
  test('同じセッションから同時に2回実行しても、件数の合計は実際の行数と同じ（二重に数えない）', async () => {
    const person = await createLoginPerson();
    for (let i = 0; i < 3; i++) await createSessionWithToken(person.accountId);
    for (let i = 0; i < 2; i++) await insertApiToken(person.accountId, { expiresAt: future() });

    const responses = await Promise.all([revokeAll(person.token), revokeAll(person.token)]);
    for (const res of responses) expect(res.status).toBe(200);
    const [a, b] = (await Promise.all(responses.map((res) => res.json()))) as Counts[];
    expect(a!.revoked_sessions + b!.revoked_sessions).toBe(3);
    expect(a!.revoked_tokens + b!.revoked_tokens).toBe(2);
    expect((await sessionRowsOf(person.accountId)).map((row) => row.token_hash)).toEqual([
      await hashSessionToken(person.token),
    ]);
  });
});

describe('件数と行の数が大きいとき', () => {
  test('150件のセッションと150件のトークンでも、件数は行数と一致し、今のセッションだけ残る', async () => {
    const person = await createLoginPerson();
    await Promise.all(Array.from({ length: 150 }, () => createSessionWithToken(person.accountId)));
    await Promise.all(Array.from({ length: 150 }, () => insertApiToken(person.accountId, { expiresAt: future() })));
    const res = await revokeAll(person.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 150, revoked_tokens: 150 });
    expect(await sessionRowsOf(person.accountId)).toHaveLength(1);
    expect((await tokenRowsOf(person.accountId)).filter((row) => row.revoked_at === null)).toHaveLength(0);
  });
});

describe('同じ名前のトークン', () => {
  test('ほかのアカウントに同じ名前、同じスコープ、同じ作成日時のトークンがあっても、その行は変わらない', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const same = { name: '同じ名前', scope: 'read', createdAt: '2026-10-01T00:00:00.000Z' } as const;
    const mine = await insertApiToken(person.accountId, { ...same, expiresAt: future() });
    const theirs = await insertApiToken(bystander.accountId, { ...same, expiresAt: future() });
    const res = await revokeAll(person.token);
    expect(await res.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 1 });
    expect((await tokenRow(mine.hash))!.revoked_at).not.toBeNull();
    expect((await tokenRow(theirs.hash))!.revoked_at).toBeNull();
  });

  test('ほかのアカウントのトークンが取り消し済みで、自分のトークンが未取り消しでも、自分の分だけ数える', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    for (let i = 0; i < 4; i++) {
      await insertApiToken(bystander.accountId, { revokedAt: '2026-10-25T00:00:00.000Z', expiresAt: future() });
    }
    await insertApiToken(person.accountId, { expiresAt: future() });
    expect(await (await revokeAll(person.token)).json()).toEqual({ revoked_sessions: 0, revoked_tokens: 1 });
    expect((await tokenRowsOf(bystander.accountId)).every((row) => row.revoked_at === '2026-10-25T00:00:00.000Z')).toBe(
      true,
    );
  });
});

describe('revoked_at の値', () => {
  test('1回の実行で書く revoked_at は、すべてのトークンで同じ ISO 8601 の日時', async () => {
    const person = await createLoginPerson();
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) hashes.push((await insertApiToken(person.accountId, { expiresAt: future() })).hash);
    await revokeAll(person.token);
    const values = await Promise.all(hashes.map(async (hash) => (await tokenRow(hash))!.revoked_at));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('revoked_at が空文字の行は NULL ではないので、認証と同じく取り消し済みとして扱い、書き換えず、数えない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, { revokedAt: '', expiresAt: future() });
    expect(await (await revokeAll(person.token)).json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect((await tokenRow(hash))!.revoked_at).toBe('');
  });

  test('未来の日時が入った revoked_at の行は、取り消し済みとして書き換えない', async () => {
    const person = await createLoginPerson();
    const at = '2099-01-01T00:00:00.000Z';
    const { hash } = await insertApiToken(person.accountId, { revokedAt: at, expiresAt: future() });
    expect(await (await revokeAll(person.token)).json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect((await tokenRow(hash))!.revoked_at).toBe(at);
  });

  test('取り消しても行は消えない（期限切れの行も、行数は実行の前後で同じ）', async () => {
    const person = await createLoginPerson();
    await insertApiToken(person.accountId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await insertApiToken(person.accountId, { expiresAt: future() });
    await revokeAll(person.token);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(2);
  });
});

describe('deleteOtherSessionsOf の境界', () => {
  const db = () => commonDb(env);

  test('ほかのアカウントのハッシュを今のセッションとして渡すと、0 を返し、その人のセッションも渡したハッシュの行も消えない', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const theirs = await createSessionWithToken(bystander.accountId);
    await createSessionWithToken(person.accountId);
    const mineBefore = await sessionRowsOf(person.accountId);
    const theirsBefore = await sessionRowsOf(bystander.accountId);
    const deleted = await deleteOtherSessionsOf(db(), person.accountId, theirs.row.token_hash);
    expect(deleted).toBe(0);
    expect(await sessionRowsOf(person.accountId)).toEqual(mineBefore);
    expect(mineBefore).toHaveLength(2);
    expect(await sessionRowsOf(bystander.accountId)).toEqual(theirsBefore);
    expect((await sessionRowsOf(bystander.accountId)).map((row) => row.token_hash)).toContain(theirs.row.token_hash);
  });

  test('空文字を今のセッションとして渡しても、ほかのアカウントの行は消えない', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const before = await sessionRowsOf(bystander.accountId);
    await deleteOtherSessionsOf(db(), person.accountId, '');
    expect(await sessionRowsOf(bystander.accountId)).toEqual(before);
    expect((await callMe(bystander.token)).status).toBe(200);
  });
});

// #767: 全失効の2文に「今のセッションの行（token_hash と account_id が一致）がまだある」条件を足した実装を崩す。
// test/credentials-revoke-all.test.ts の「同時に全失効を実行したとき」（2つのセッション、文を順に流す形と1回の割り込み）と
// 重ならない手口だけ置く（3つ以上のセッション、入れ子の割り込み、logout との競合、ログインし直し、大文字のハッシュ、
// 期限切れの今のセッションの行、文の数と順）
describe('#767 を崩す', () => {
  const revokeAllIn = (token: string, hookedEnv: Env) => post(app, credentialsRevokeAll, { token, env: hookedEnv });
  const hashesOf = async (accountId: string) => (await sessionRowsOf(accountId)).map((row) => row.token_hash).sort();

  // 要求が認証と同意の確かめを終え、書き込みの batch() を送る前に between を await する env（同意の読み取りの直後で止める）
  function pausedAfterAuth(between: () => Promise<void>) {
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

  test('3つのセッションが Promise.all で同時に実行しても、ちょうど1つが残り、それは件数を返した側で、件数の合計は行数と同じ', async () => {
    const person = await createLoginPerson();
    const b = await createSessionWithToken(person.accountId);
    const c = await createSessionWithToken(person.accountId);
    for (let i = 0; i < 3; i++) await insertApiToken(person.accountId, { expiresAt: future() });
    const tokens = [person.token, b.token, c.token];

    const responses = await Promise.all(tokens.map((token) => revokeAll(token)));
    for (const res of responses) expect(res.status).toBe(200);
    const counts = (await Promise.all(responses.map((res) => res.json()))) as Counts[];

    expect(counts.reduce((sum, x) => sum + x.revoked_sessions, 0)).toBe(2);
    expect(counts.reduce((sum, x) => sum + x.revoked_tokens, 0)).toBe(3);
    const remaining = await sessionRowsOf(person.accountId);
    expect(remaining).toHaveLength(1);
    const winner = counts.findIndex((x) => x.revoked_sessions === 2);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(remaining[0]!.token_hash).toBe(await hashSessionToken(tokens[winner]!));
    expect((await tokenRowsOf(person.accountId)).every((row) => row.revoked_at !== null)).toBe(true);
  });

  test('入れ子の割り込み: B と C が認証を通った後に A が全部を終えると、C も B も 200 で 0 と 0、A だけが残り、revoked_at は A の値のまま', async () => {
    const person = await createLoginPerson();
    const b = await createSessionWithToken(person.accountId);
    const c = await createSessionWithToken(person.accountId);
    const { hash } = await insertApiToken(person.accountId, { expiresAt: future() });
    let first: Counts | undefined;
    let revokedAt: string | null | undefined;
    let cRes: Response | undefined;
    const cPaused = pausedAfterAuth(async () => {
      const res = await revokeAll(person.token);
      expect(res.status).toBe(200);
      first = (await res.json()) as Counts;
      revokedAt = (await tokenRow(hash))!.revoked_at;
    });
    const bPaused = pausedAfterAuth(async () => {
      cRes = await revokeAllIn(c.token, cPaused.env);
    });

    const bRes = await revokeAllIn(b.token, bPaused.env);

    expect(bPaused.state.ran).toBe(true);
    expect(cPaused.state.ran).toBe(true);
    expect(first).toEqual({ revoked_sessions: 2, revoked_tokens: 1 });
    expect(cRes!.status).toBe(200);
    expect(await cRes!.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect(bRes.status).toBe(200);
    expect(await bRes.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect(await hashesOf(person.accountId)).toEqual([await hashSessionToken(person.token)]);
    expect(revokedAt).not.toBeNull();
    expect((await tokenRow(hash))!.revoked_at).toBe(revokedAt);
  });

  test('logout との競合: B の認証の後に B 自身が logout すると、B の全失効は 200 で 0 と 0、ほかのセッションもトークンも残る', async () => {
    const person = await createLoginPerson();
    const b = await createSessionWithToken(person.accountId);
    const c = await createSessionWithToken(person.accountId);
    const { hash } = await insertApiToken(person.accountId, { expiresAt: future() });
    const paused = pausedAfterAuth(async () => {
      expect((await post(app, logout, { token: b.token })).status).toBeLessThan(300);
    });

    const res = await revokeAllIn(b.token, paused.env);

    expect(paused.state.ran).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect(await hashesOf(person.accountId)).toEqual([await hashSessionToken(person.token), c.row.token_hash].sort());
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('盗まれた Cookie が先に通って本人が 0 件になっても、本人がログインし直してもう一度実行すれば、盗まれたセッションを締め出せる', async () => {
    const owner = await createLoginPerson();
    const stolen = await createSessionWithToken(owner.accountId);
    const paused = pausedAfterAuth(async () => {
      expect((await (await revokeAll(stolen.token)).json()) as Counts).toEqual({
        revoked_sessions: 1,
        revoked_tokens: 0,
      });
    });

    const ownerRes = await revokeAllIn(owner.token, paused.env);
    expect(ownerRes.status).toBe(200);
    expect(await ownerRes.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect((await callMe(owner.token)).status).toBe(401);

    const relogin = await createSessionWithToken(owner.accountId);
    expect(await (await revokeAll(relogin.token)).json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
    expect(await hashesOf(owner.accountId)).toEqual([relogin.row.token_hash]);
    expect((await callMe(stolen.token)).status).toBe(401);
  });

  describe('文の条件', () => {
    const db = () => commonDb(env);

    test('大文字の16進にした今のセッションのハッシュを渡すと、行と一致しない（BINARY の比較）ので、セッションもトークンも何も変えない', async () => {
      const person = await createLoginPerson();
      await createSessionWithToken(person.accountId);
      const { hash } = await insertApiToken(person.accountId, { expiresAt: future() });
      const upper = (await hashSessionToken(person.token)).toUpperCase();
      const before = await sessionRowsOf(person.accountId);
      const entry = db();
      const [sessions, tokens] = await entry.batch([
        deleteOtherSessionsStatement(entry, person.accountId, upper),
        revokeAllApiTokensStatement(entry, person.accountId, new Date(), upper),
      ]);
      expect(sessions.changes).toBe(0);
      expect(tokens.changes).toBe(0);
      expect(await sessionRowsOf(person.accountId)).toEqual(before);
      expect((await tokenRow(hash))!.revoked_at).toBeNull();
    });

    test('今のセッションの行は期限を見ない: 期限切れでも行があれば、ほかのセッションを消しトークンを取り消す（条件は token_hash と account_id だけ）', async () => {
      const person = await createLoginPerson();
      const expired = await createSessionWithToken(person.accountId, {
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      await insertApiToken(person.accountId, { expiresAt: future() });
      const entry = db();
      const [sessions, tokens] = await entry.batch([
        deleteOtherSessionsStatement(entry, person.accountId, expired.row.token_hash),
        revokeAllApiTokensStatement(entry, person.accountId, new Date(), expired.row.token_hash),
      ]);
      expect(sessions.changes).toBe(1);
      expect(tokens.changes).toBe(1);
      expect(await hashesOf(person.accountId)).toEqual([expired.row.token_hash]);
    });

    test('操作の書き込みは2文だけの1つの batch() で、セッションの削除、トークンの取り消しの順。どちらも今のセッションの行の EXISTS を持つ', async () => {
      const person = await createLoginPerson();
      await createSessionWithToken(person.accountId);
      const batches: (readonly string[])[] = [];
      const recording = envWithD1Hooks(testEnv, { beforeBatch: (sqls) => void batches.push(sqls) });
      expect((await revokeAllIn(person.token, recording)).status).toBe(200);
      const writes = batches.filter((sqls) =>
        sqls.some((sql) => sql.startsWith('delete from "sessions"') || sql.startsWith('update "api_tokens"')),
      );
      expect(writes).toHaveLength(1);
      const [del, upd] = writes[0]!;
      expect(writes[0]).toHaveLength(2);
      expect(del!.startsWith('delete from "sessions"')).toBe(true);
      expect(upd!.startsWith('update "api_tokens"')).toBe(true);
      for (const sql of [del!, upd!]) {
        expect(sql).toMatch(/exists \(select/);
        expect(sql).toContain('"cs"."token_hash" = ?');
        expect(sql).toContain('"cs"."account_id" = ?');
      }
    });
  });
});
