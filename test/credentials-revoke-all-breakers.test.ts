// credentials-revoke-all を崩す検査。test/credentials-revoke-all.test.ts と重ならない手口だけ置く（並行、大きな件数、
// 似たハッシュ、取り消しの日時の形、別のアカウントの似た行）
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { credentialsRevokeAll, me } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { hashSessionToken, deleteOtherSessionsOf } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson } from './operations/world.ts';

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
