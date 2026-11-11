// #1144: 作成日時の表記や日付の境界で、古い Cookie が新しいログインを消せない。
import { expect, test } from 'vitest';
import { credentialsRevokeAll, me } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { hashSessionToken } from '../src/server/auth/session.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionRowsOf } from './auth/helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson } from './operations/world.ts';

const app = createApp([...implementedOperations]);

test.each([
  { current: '2026-01-01 00:00:00', same: '2026-01-01T00:00:00.000Z', newer: '2026-01-01T00:00:00.001Z' },
  { current: '2026-01-01T00:00:00.000Z', same: '2026-01-01 00:00:00', newer: '2026-01-01 00:00:00.001' },
  { current: '2026-01-01T08:59:59.999+09:00', same: '2025-12-31T23:59:59.999Z', newer: '2026-01-01 00:00:00' },
])('表記の異なる同時刻は消し、1ミリ秒後は残す: $current', async ({ current, same, newer }) => {
  const owner = await createLoginPerson({ sessionOverrides: { created_at: current } });
  const equalSession = await createSessionWithToken(owner.accountId, { created_at: same });
  const newSession = await createSessionWithToken(owner.accountId, { created_at: newer });

  const response = await post(app, credentialsRevokeAll, { token: owner.token });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
  expect((await sessionRowsOf(owner.accountId)).map((row) => row.token_hash).sort()).toEqual(
    [await hashSessionToken(owner.token), newSession.row.token_hash].sort(),
  );
  expect((await post(app, me, { token: equalSession.token })).status).toBe(401);
  expect((await post(app, me, { token: newSession.token })).status).toBe(200);

  // 同じ Cookie で繰り返しても後からのログインは残り、新しい側からは古い側を締め出せる。
  expect(await (await post(app, credentialsRevokeAll, { token: owner.token })).json()).toEqual({
    revoked_sessions: 0,
    revoked_tokens: 0,
  });
  const recovery = await post(app, credentialsRevokeAll, { token: newSession.token });
  expect(recovery.status).toBe(200);
  expect(await recovery.json()).toEqual({ revoked_sessions: 1, revoked_tokens: 0 });
  expect((await post(app, me, { token: owner.token })).status).toBe(401);
  expect((await sessionRowsOf(owner.accountId)).map((row) => row.token_hash)).toEqual([newSession.row.token_hash]);
});
