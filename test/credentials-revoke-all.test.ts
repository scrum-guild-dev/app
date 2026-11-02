// 設定からの全失効（credentials-revoke-all）。今のセッション以外のすべてのセッションと、取り消していないすべての API トークンを無効にする。
// Cookie のセッションだけが使える（cookieOnly）。一覧を回す検査は test/operation-registry.test.ts、トークン全般の取り決めは test/api-token-operations.test.ts
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import {
  credentialsRevokeAll,
  logout,
  me,
  operationList,
  tokenCreate,
} from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { hashSessionToken, deleteOtherSessionsOf } from '../src/server/auth/session.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createAccount, createAccountLogin, createSessionWithToken } from './factories.ts';
import { insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson, testEnv } from './operations/world.ts';
import type { Person } from './operations/world.ts';

const app = createApp([...implementedOperations]);
const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days = 30) => new Date(Date.now() + days * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

const revokeAll = (token: string, extra: Parameters<typeof post>[2] = {}) =>
  post(app, credentialsRevokeAll, { token, ...extra });
const callMe = (options: Parameters<typeof post>[2]) => post(app, me, options);

type Counts = { revoked_sessions: number; revoked_tokens: number };
async function revoked(token: string): Promise<Counts> {
  const res = await revokeAll(token);
  expect(res.status).toBe(200);
  return (await res.json()) as Counts;
}

// 同じ人の別のセッション（別の端末、盗まれた Cookie の想定）
async function otherSession(person: Person, overrides: Parameters<typeof createSessionWithToken>[1] = {}) {
  return createSessionWithToken(person.accountId, overrides);
}

async function expectSignedOut(res: Response) {
  expect(res.status).toBe(401);
  expect(await errorCodeOf(res)).toBe('unauthenticated');
}

// 認証が書き直す列（セッションの last_used_at と expires_at、トークンの last_used_at）を除いて比べる
const omit = <T extends object>(row: T, keys: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const stableSessions = (rows: Awaited<ReturnType<typeof sessionRowsOf>>) =>
  rows.map((row) => omit(row, ['last_used_at', 'expires_at']));
const stableTokens = (rows: Awaited<ReturnType<typeof tokenRowsOf>>) => rows.map((row) => omit(row, ['last_used_at']));

async function sessionHashesOf(accountId: string) {
  return (await sessionRowsOf(accountId)).map((row) => row.token_hash).sort();
}

describe('操作の定義', () => {
  test('ログインの権限の write で、Cookie だけ。入力は空、再認証もレート制限も同意の免除も無い', () => {
    const definition: AnyOperationDefinition = credentialsRevokeAll;
    expect(credentialsRevokeAll.name).toBe('credentials-revoke-all');
    expect(credentialsRevokeAll.permission).toBe('login');
    expect(credentialsRevokeAll.mode).toBe('write');
    expect(credentialsRevokeAll.cookieOnly).toBe(true);
    expect(definition.skipsConsent).toBeUndefined();
    expect(definition.rateLimit).toBeUndefined();
    expect(definition.workspace).toBeUndefined();
    expect(credentialsRevokeAll.description).toMatch(/[぀-ヿ一-鿿]/);
    expect(credentialsRevokeAll.input.safeParse({}).success).toBe(true);
    expect(credentialsRevokeAll.output.safeParse({ revoked_sessions: 0, revoked_tokens: 0 }).success).toBe(true);
    expect(credentialsRevokeAll.output.safeParse({ revoked_sessions: 1.5, revoked_tokens: 0 }).success).toBe(false);
    expect(credentialsRevokeAll.output.safeParse({ revoked_sessions: 0 }).success).toBe(false);
  });

  test('操作の一覧に入り、本番の処理も結ばれている', () => {
    expect(operations).toContain(credentialsRevokeAll);
    expect(implementedOperations.map((operation) => operation.definition)).toContain(credentialsRevokeAll);
  });

  test('operation-list には、logout やトークンの操作と同じく載らない（cookieOnly は Cookie の呼び出しにも載せない）', async () => {
    const person = await createLoginPerson();
    const names = (res: Response) =>
      res.json().then((body) => (body as { operations: { name: string }[] }).operations.map((o) => o.name));
    const byCookie = await post(app, operationList, { token: person.token });
    expect(await names(byCookie)).not.toContain('credentials-revoke-all');
    const { raw } = await insertApiToken(person.accountId, { expiresAt: future() });
    const byToken = await post(app, operationList, { bearer: raw, origin: null });
    expect(byToken.status).toBe(200);
    expect(await names(byToken)).not.toContain('credentials-revoke-all');
  });
});

describe('完了条件1: 今のセッション以外のセッションが消える', () => {
  test('今のセッション、別端末、盗まれた Cookie の想定のセッションのうち、実行したセッションだけが残る', async () => {
    const person = await createLoginPerson();
    const laptop = await otherSession(person);
    const stolen = await otherSession(person);
    expect(await sessionRowsOf(person.accountId)).toHaveLength(3);

    const res = await revokeAll(person.token);
    expect(res.status).toBe(200);

    const rows = await sessionRowsOf(person.accountId);
    expect(rows.map((row) => row.token_hash)).toEqual([await hashSessionToken(person.token)]);
    expect(rows.map((row) => row.token_hash)).not.toContain(laptop.row.token_hash);
    expect(rows.map((row) => row.token_hash)).not.toContain(stolen.row.token_hash);
  });

  test('消えたセッションの Cookie での呼び出しは 401 の unauthenticated（logout の後と同じ形）', async () => {
    const person = await createLoginPerson();
    const laptop = await otherSession(person);
    const stolen = await otherSession(person);
    expect((await callMe({ token: laptop.token })).status).toBe(200);
    expect((await callMe({ token: stolen.token })).status).toBe(200);

    await revoked(person.token);

    const afterRevokeAll = await callMe({ token: laptop.token });
    const revokeAllBody = await afterRevokeAll.clone().text();
    await expectSignedOut(afterRevokeAll);
    await expectSignedOut(await callMe({ token: stolen.token }));

    // logout の後の 401 と、状態も本文も同じ
    const loggedOut = await otherSession(person);
    expect((await post(app, logout, { token: loggedOut.token })).status).toBe(200);
    const afterLogout = await callMe({ token: loggedOut.token });
    expect(afterLogout.status).toBe(401);
    expect(await afterLogout.text()).toBe(revokeAllBody);
  });

  test('消えたセッションでは、書き込みの操作も 401 で、何も起きない', async () => {
    const person = await createLoginPerson();
    const stolen = await otherSession(person);
    await revoked(person.token);
    await expectSignedOut(await post(app, tokenCreate, { token: stolen.token, body: { name: 'x', scope: 'write' } }));
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
    await expectSignedOut(await revokeAll(stolen.token));
  });

  test('期限が切れた行も、期限内の行も、ほかのセッションはすべて消える', async () => {
    const person = await createLoginPerson();
    await otherSession(person, { expires_at: past() });
    await otherSession(person, { expires_at: future(29) });
    await otherSession(person, { last_used_at: '2026-01-01T00:00:00.000Z' });
    const counts = await revoked(person.token);
    expect(counts.revoked_sessions).toBe(3);
    expect(await sessionRowsOf(person.accountId)).toHaveLength(1);
  });
});

describe('完了条件2: 取り消していないトークンがすべて取り消される', () => {
  test('read と write のトークンがすべて取り消され、そのトークンでの呼び出しは 401', async () => {
    const person = await createLoginPerson();
    const write = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
    const read = await insertApiToken(person.accountId, { scope: 'read', expiresAt: future() });
    for (const token of [write, read]) {
      expect((await callMe({ bearer: token.raw, origin: null })).status).toBe(200);
    }

    const before = Date.now();
    await revoked(person.token);
    const after = Date.now();

    for (const token of [write, read]) {
      const row = (await tokenRow(token.hash))!;
      expect(row.revoked_at).not.toBeNull();
      const at = Date.parse(row.revoked_at!);
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(after + 1000);
      await expectSignedOut(await callMe({ bearer: token.raw, origin: null }));
    }
  });

  test('実行前から取り消し済みのトークンの revoked_at は、実行の前後で同じ', async () => {
    const person = await createLoginPerson();
    const revokedAt = '2026-10-25T01:02:03.000Z';
    const done = await insertApiToken(person.accountId, { revokedAt, expiresAt: future() });
    const active = await insertApiToken(person.accountId, { expiresAt: future() });
    const beforeRow = (await tokenRow(done.hash))!;

    await revoked(person.token);

    expect(await tokenRow(done.hash)).toEqual(beforeRow);
    expect((await tokenRow(done.hash))!.revoked_at).toBe(revokedAt);
    expect((await tokenRow(active.hash))!.revoked_at).not.toBeNull();
    expect((await tokenRow(active.hash))!.revoked_at).not.toBe(revokedAt);
  });

  test('期限切れで取り消していないトークンは、取り消していない行なので revoked_at が書かれて数に入る', async () => {
    const person = await createLoginPerson();
    const expired = await insertApiToken(person.accountId, { expiresAt: past() });
    const counts = await revoked(person.token);
    expect(counts.revoked_tokens).toBe(1);
    expect((await tokenRow(expired.hash))!.revoked_at).not.toBeNull();
  });

  test('取り消す列は revoked_at だけ。ほかの列は変わらない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, {
      name: '手元の CLI',
      scope: 'read',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: '2026-10-02T03:04:05.000Z',
      expiresAt: future(10),
    });
    const beforeRow = (await tokenRow(hash))!;
    await revoked(person.token);
    expect(await tokenRow(hash)).toEqual({ ...beforeRow, revoked_at: expect.any(String) });
  });
});

describe('応答の件数', () => {
  test('{ revoked_sessions, revoked_tokens } だけで、実際に消えた行数、取り消した行数と一致する', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    await otherSession(person);
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    await insertApiToken(person.accountId, { scope: 'read', expiresAt: future() });
    await insertApiToken(person.accountId, { expiresAt: past() });
    await insertApiToken(person.accountId, { revokedAt: past(), expiresAt: future() });
    const sessionsBefore = (await sessionRowsOf(person.accountId)).length;
    const unrevokedBefore = (await tokenRowsOf(person.accountId)).filter((row) => row.revoked_at === null).length;

    const res = await revokeAll(person.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Counts;
    expect(Object.keys(body).sort()).toEqual(['revoked_sessions', 'revoked_tokens']);
    expect(body).toEqual({ revoked_sessions: 3, revoked_tokens: 3 });
    expect(body.revoked_sessions).toBe(sessionsBefore - (await sessionRowsOf(person.accountId)).length);
    expect(body.revoked_tokens).toBe(
      unrevokedBefore - (await tokenRowsOf(person.accountId)).filter((row) => row.revoked_at === null).length,
    );
    expect(credentialsRevokeAll.output.safeParse(body).success).toBe(true);
  });

  test('トークンも他のセッションも無いときは、0 と 0 で成功し、今のセッションは使える', async () => {
    const person = await createLoginPerson();
    const res = await revokeAll(person.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect((await callMe({ token: person.token })).status).toBe(200);
  });

  test('取り消し済みのトークンしか無いときは、トークンの数は 0', async () => {
    const person = await createLoginPerson();
    await insertApiToken(person.accountId, { revokedAt: past(), expiresAt: future() });
    expect(await revoked(person.token)).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
  });

  test('2回続けて実行すると、2回目は 0 と 0 で、今のセッションは残る', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    expect(await revoked(person.token)).toEqual({ revoked_sessions: 1, revoked_tokens: 1 });
    expect(await revoked(person.token)).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect(await sessionHashesOf(person.accountId)).toEqual([await hashSessionToken(person.token)]);
    expect((await callMe({ token: person.token })).status).toBe(200);
  });

  test('2回続けて実行したとき、1回目で書いた revoked_at を2回目は書き換えない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId, { expiresAt: future() });
    await revoked(person.token);
    const first = (await tokenRow(hash))!.revoked_at;
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await revoked(person.token)).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect((await tokenRow(hash))!.revoked_at).toBe(first);
  });
});

describe('完了条件3: 今のセッションは使える。ほかのアカウントには何も起きない', () => {
  test('実行の後も、今のセッションの Cookie で呼べて、行の last_used_at などは変わらない', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    const hash = await hashSessionToken(person.token);
    const before = (await sessionRowsOf(person.accountId)).find((row) => row.token_hash === hash)!;
    await revoked(person.token);
    expect((await callMe({ token: person.token })).status).toBe(200);
    const after = (await sessionRowsOf(person.accountId)).find((row) => row.token_hash === hash)!;
    expect(after.account_id).toBe(before.account_id);
    expect(after.created_at).toBe(before.created_at);
    expect(after.expires_at).toBe(before.expires_at);
  });

  test('今のセッションで、そのまま続けてトークンの一覧や次の実行ができる', async () => {
    const person = await createLoginPerson();
    await revoked(person.token);
    expect((await revokeAll(person.token)).status).toBe(200);
  });

  test('ほかのアカウントのセッションとトークンは、行も列も変わらない', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    const theirSecond = await otherSession(bystander);
    const theirActive = await insertApiToken(bystander.accountId, { expiresAt: future() });
    const theirRevoked = await insertApiToken(bystander.accountId, { revokedAt: past(), expiresAt: future() });
    const theirExpired = await insertApiToken(bystander.accountId, { expiresAt: past() });
    const sessionsBefore = await sessionRowsOf(bystander.accountId);
    const tokensBefore = await tokenRowsOf(bystander.accountId);
    expect(sessionsBefore).toHaveLength(2);

    expect(await revoked(person.token)).toEqual({ revoked_sessions: 1, revoked_tokens: 1 });

    expect(await sessionRowsOf(bystander.accountId)).toEqual(sessionsBefore);
    expect(await tokenRowsOf(bystander.accountId)).toEqual(tokensBefore);
    for (const hash of [theirActive.hash, theirRevoked.hash, theirExpired.hash]) {
      expect(tokensBefore.map((row) => row.token_hash)).toContain(hash);
    }
    expect((await callMe({ token: bystander.token })).status).toBe(200);
    expect((await callMe({ token: theirSecond.token })).status).toBe(200);
    expect((await callMe({ bearer: theirActive.raw, origin: null })).status).toBe(200);
  });

  test('ほかのアカウントのトークンを入力で指しても効かない（余計なキーは捨てられる）', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const theirs = await insertApiToken(bystander.accountId, { expiresAt: future() });
    const theirSession = await otherSession(bystander);
    const res = await revokeAll(person.token, {
      body: { account_id: bystander.accountId, id: theirs.hash, token_hash: theirSession.row.token_hash },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 0, revoked_tokens: 0 });
    expect((await tokenRow(theirs.hash))!.revoked_at).toBeNull();
    expect(await sessionRowsOf(bystander.accountId)).toHaveLength(2);
  });

  test('入力の余計なキーは、ほかの操作と同じく捨てられ、結果は空の入力と同じ', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    const res = await revokeAll(person.token, { body: { keep_current: false, all: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
    expect(await sessionHashesOf(person.accountId)).toEqual([await hashSessionToken(person.token)]);
  });

  test('今のセッションも消す形はない（どんな入力でも今のセッションは残る）', async () => {
    const person = await createLoginPerson();
    for (const body of [{}, { include_current: true }, { current: true }]) {
      expect((await revokeAll(person.token, { body })).status).toBe(200);
      expect((await callMe({ token: person.token })).status).toBe(200);
    }
  });
});

describe('完了条件4: 盗まれた Cookie は、本人がログインし直したセッションからの実行で使えなくなる', () => {
  test('盗まれた Cookie（古いセッション）と、本人のログインし直したセッションがあるとき、後者で実行すると前者は 401', async () => {
    const person = await createLoginPerson();
    const stolen = await otherSession(person, { created_at: '2026-10-01T00:00:00.000Z' });
    const reLogin = await otherSession(person);
    expect((await callMe({ token: stolen.token })).status).toBe(200);

    expect((await revokeAll(reLogin.token)).status).toBe(200);

    await expectSignedOut(await callMe({ token: stolen.token }));
    await expectSignedOut(await post(app, credentialsRevokeAll, { token: stolen.token }));
    expect((await callMe({ token: reLogin.token })).status).toBe(200);
  });

  test('盗まれた Cookie が API トークンを持っていても、同時に取り消される', async () => {
    const person = await createLoginPerson();
    const stolen = await otherSession(person);
    const reLogin = await otherSession(person);
    const planted = await insertApiToken(person.accountId, { expiresAt: future() });
    await revoked(reLogin.token);
    await expectSignedOut(await callMe({ token: stolen.token }));
    await expectSignedOut(await callMe({ bearer: planted.raw, origin: null }));
  });
});

describe('ログインから時間がたったセッション', () => {
  test('再認証の猶予（10分）を過ぎたセッションでも実行できる。token-create は reauth_required になる対照つき', async () => {
    const person = await createLoginPerson({
      sessionOverrides: { created_at: new Date(Date.now() - 3 * DAY_MS).toISOString() },
    });
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    const create = await post(app, tokenCreate, { token: person.token, body: { name: 'x', scope: 'read' } });
    expect(create.status).toBe(403);
    expect(await errorCodeOf(create)).toBe('reauth_required');

    expect(await revoked(person.token)).toEqual({ revoked_sessions: 1, revoked_tokens: 1 });
    expect((await callMe({ token: person.token })).status).toBe(200);
  });
});

describe('回数の上限は設けない', () => {
  test('続けて何度実行しても 429 にならない', async () => {
    const person = await createLoginPerson();
    for (let i = 0; i < 40; i++) {
      const res = await revokeAll(person.token);
      expect(res.status, `${i + 1}回目`).toBe(200);
    }
  });
});

describe('完了条件5と断る場合: API トークンからは 403 の forbidden', () => {
  test.each(['write', 'read'] as const)('%s のトークンからは 403 の forbidden で、何も消えない', async (scope) => {
    const person = await createLoginPerson();
    const laptop = await otherSession(person);
    const { raw, hash } = await insertApiToken(person.accountId, { scope, expiresAt: future() });
    const sessionsBefore = await sessionRowsOf(person.accountId);
    const tokensBefore = await tokenRowsOf(person.accountId);

    const res = await post(app, credentialsRevokeAll, { bearer: raw, origin: null });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');

    expect(stableSessions(await sessionRowsOf(person.accountId))).toEqual(stableSessions(sessionsBefore));
    expect(stableTokens(await tokenRowsOf(person.accountId))).toEqual(stableTokens(tokensBefore));
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
    expect((await callMe({ bearer: raw, origin: null })).status).toBe(200);
    expect((await callMe({ token: laptop.token })).status).toBe(200);
  });

  test('トークンと Cookie を両方付けても、トークンとして断る', async () => {
    const person = await createLoginPerson();
    const other = await otherSession(person);
    const { raw } = await insertApiToken(person.accountId, { expiresAt: future() });
    const res = await post(app, credentialsRevokeAll, { bearer: raw, token: person.token });
    expect(res.status).toBe(403);
    expect(await sessionRowsOf(person.accountId)).toHaveLength(2);
    expect((await callMe({ token: other.token })).status).toBe(200);
  });

  test('入力が不正でも、トークンからは 403（入力を読む前）', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { expiresAt: future() });
    const res = await post(app, credentialsRevokeAll, { bearer: raw, rawBody: '{broken' });
    expect(res.status).toBe(403);
  });

  test('取り消し済みのトークンからは 401（トークンとして認証できない）', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { revokedAt: past(), expiresAt: future() });
    await expectSignedOut(await post(app, credentialsRevokeAll, { bearer: raw, origin: null }));
  });
});

describe('断る場合: 認証、Origin、同意、入力', () => {
  test('Cookie も無いと 401 の unauthenticated', async () => {
    await expectSignedOut(await post(app, credentialsRevokeAll, {}));
  });

  test('存在しないセッションの Cookie は 401 で、どのアカウントの行も変わらない', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    const sessionsBefore = await sessionRowsOf(person.accountId);
    const tokensBefore = await tokenRowsOf(person.accountId);
    await expectSignedOut(await revokeAll('x'.repeat(43)));
    expect(await sessionRowsOf(person.accountId)).toEqual(sessionsBefore);
    expect(await tokenRowsOf(person.accountId)).toEqual(tokensBefore);
  });

  test('期限が切れた今のセッションでは実行できず、何も起きない', async () => {
    const person = await createLoginPerson({ sessionOverrides: { expires_at: past() } });
    await otherSession(person);
    await expectSignedOut(await revokeAll(person.token));
    expect(await sessionRowsOf(person.accountId)).toHaveLength(2);
  });

  test.each(['https://evil.example', null])('Origin が %s だと 403 で、何も消えない', async (origin) => {
    const person = await createLoginPerson();
    await otherSession(person);
    const { hash } = await insertApiToken(person.accountId, { expiresAt: future() });
    const res = await revokeAll(person.token, { origin });
    expect(res.status).toBe(403);
    expect(await sessionRowsOf(person.accountId)).toHaveLength(2);
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('今の版の規約に同意していない人は 403 の terms_required で、何も消えない（同意の免除は付けない）', async () => {
    const person = await createLoginPerson({ consented: false });
    await otherSession(person);
    const { hash } = await insertApiToken(person.accountId, { expiresAt: future() });
    const res = await revokeAll(person.token);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('terms_required');
    expect(await sessionRowsOf(person.accountId)).toHaveLength(2);
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('組織に入れない人（どの組織にも属さないアカウント）でも実行できる', async () => {
    const account = await createAccount({}, { consented: true });
    await createAccountLogin(account.id);
    const current = await createSessionWithToken(account.id);
    const laptop = await createSessionWithToken(account.id);
    const res = await revokeAll(current.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
    await expectSignedOut(await callMe({ token: laptop.token }));
  });

  test.each([[null], [[]], ['x'], [1]])('入力が object でない（%j）と 400 で、何も消えない', async (body) => {
    const person = await createLoginPerson();
    await otherSession(person);
    const res = await revokeAll(person.token, { rawBody: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(await sessionRowsOf(person.accountId)).toHaveLength(2);
  });

  test('本文が壊れた JSON のときは 400 で、何も消えない', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    const res = await revokeAll(person.token, { rawBody: '{broken' });
    expect(res.status).toBe(400);
    expect(await sessionRowsOf(person.accountId)).toHaveLength(2);
  });
});

describe('同じ batch() で送る（半端な状態を残さない）', () => {
  // 実行する人の他のセッションを消す文と、トークンを取り消す文
  const deletesSessions = (sql: string) => sql.startsWith('delete from "sessions"');
  const revokesTokens = (sql: string) => sql.startsWith('update "api_tokens"');

  test('セッションを消す文とトークンを取り消す文が、1つの batch() に入っている', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    const batches: (readonly string[])[] = [];
    const recording = envWithD1Hooks(testEnv, { beforeBatch: (sqls) => void batches.push(sqls) });
    const res = await revokeAll(person.token, { env: recording });
    expect(res.status).toBe(200);
    const writes = batches.filter((sqls) => sqls.some((sql) => deletesSessions(sql) || revokesTokens(sql)));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.some(deletesSessions)).toBe(true);
    expect(writes[0]!.some(revokesTokens)).toBe(true);
  });

  test('送るのが失敗したら、セッションもトークンも何も変わらない（セッションだけ消えてトークンが残る、にならない）', async () => {
    const person = await createLoginPerson();
    const laptop = await otherSession(person);
    const { raw, hash } = await insertApiToken(person.accountId, { expiresAt: future() });
    const sessionsBefore = await sessionRowsOf(person.accountId);
    const tokensBefore = await tokenRowsOf(person.accountId);
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => deletesSessions(sql) || revokesTokens(sql))) throw new Error('secret SQL detail');
      },
    });

    const res = await revokeAll(person.token, { env: failing });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('internal');
    expect(text).not.toContain('secret SQL detail');

    expect(stableSessions(await sessionRowsOf(person.accountId))).toEqual(stableSessions(sessionsBefore));
    expect(stableTokens(await tokenRowsOf(person.accountId))).toEqual(stableTokens(tokensBefore));
    expect((await callMe({ token: laptop.token })).status).toBe(200);
    expect((await callMe({ bearer: raw, origin: null })).status).toBe(200);
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('batch() の外で、セッションやトークンを書く文を別に送らない', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    const inBatch: string[] = [];
    const recording = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => void inBatch.push(...sqls),
      afterQuery: async (sql) => {
        // rows、first、run で送られた問い合わせ。ここにセッションの削除とトークンの取り消しが来てはいけない
        expect(deletesSessions(sql) || revokesTokens(sql), sql).toBe(false);
      },
    });
    expect((await revokeAll(person.token, { env: recording })).status).toBe(200);
    expect(inBatch.some(deletesSessions)).toBe(true);
    expect(inBatch.some(revokesTokens)).toBe(true);
  });
});

describe('deleteOtherSessionsOf', () => {
  const db = () => commonDb(env);

  test('今のセッション以外を消し、消した数を返す', async () => {
    const person = await createLoginPerson();
    const a = await otherSession(person);
    const b = await otherSession(person);
    const current = await hashSessionToken(person.token);
    const deleted = await deleteOtherSessionsOf(db(), person.accountId, current);
    expect(deleted).toBe(2);
    expect(await sessionHashesOf(person.accountId)).toEqual([current]);
    expect(await sessionHashesOf(person.accountId)).not.toContain(a.row.token_hash);
    expect(await sessionHashesOf(person.accountId)).not.toContain(b.row.token_hash);
  });

  test('ほかのアカウントのセッションは残る', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    await otherSession(person);
    await otherSession(bystander);
    const theirsBefore = await sessionRowsOf(bystander.accountId);
    const deleted = await deleteOtherSessionsOf(db(), person.accountId, await hashSessionToken(person.token));
    expect(deleted).toBe(1);
    expect(await sessionRowsOf(bystander.accountId)).toEqual(theirsBefore);
    expect(theirsBefore).toHaveLength(2);
  });

  test('今のセッションしか無ければ 0 を返し、何も消えない', async () => {
    const person = await createLoginPerson();
    const before = await sessionRowsOf(person.accountId);
    expect(await deleteOtherSessionsOf(db(), person.accountId, await hashSessionToken(person.token))).toBe(0);
    expect(await sessionRowsOf(person.accountId)).toEqual(before);
  });

  test('ほかのアカウントの今のセッションのハッシュを渡しても、自分のアカウントのセッションだけを消す', async () => {
    const [person, bystander] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const mine = await otherSession(person);
    const theirsBefore = await sessionRowsOf(bystander.accountId);
    const deleted = await deleteOtherSessionsOf(db(), person.accountId, await hashSessionToken(bystander.token));
    expect(deleted).toBe(2);
    expect(await sessionRowsOf(bystander.accountId)).toEqual(theirsBefore);
    expect(await sessionHashesOf(person.accountId)).not.toContain(mine.row.token_hash);
  });

  test('API トークンの行には触らない', async () => {
    const person = await createLoginPerson();
    await otherSession(person);
    await insertApiToken(person.accountId, { expiresAt: future() });
    const before = await tokenRowsOf(person.accountId);
    await deleteOtherSessionsOf(db(), person.accountId, await hashSessionToken(person.token));
    expect(await tokenRowsOf(person.accountId)).toEqual(before);
  });
});
