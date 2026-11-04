// #675: 複数所属の同時除外、時計の巻き戻り、発行元時刻の読み取り後の変化。
import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { issueApiTokenWith } from '../src/server/auth/api-token.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { organizationInfo, userDisable, userEnable } from '../src/shared/operations/organization/index.ts';
import { invitationAccept, membershipLeave } from '../src/shared/operations/workspace/index.ts';
import {
  createAccount,
  createInvitation,
  createMembership,
  createSession,
  createSessionWithToken,
} from './factories.ts';
import { tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
afterEach(() => vi.restoreAllMocks());

async function lineOf(target: Target, person: Person) {
  const db = orgDb(env, target.organization.verified);
  const user = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('credentials_not_before')
        .where('organization_id', '=', target.organization.id)
        .where('id', '=', person.userId!),
    ),
  );
  return user?.credentials_not_before;
}

test('2つの最後の所属を同時に外しても、再招待後に古いCookieを通さない', async () => {
  const target = await createTarget();
  const person = await createPerson({
    organization: target.organization,
    membership: { workspaceId: target.workspace.id, role: 'member' },
    sessionOverrides: { created_at: new Date(Date.now() - 60_000).toISOString() },
  });
  await createMembership(target.organization, target.otherWorkspace.id, person.userId!);
  const responses = await Promise.all(
    [target.workspace.id, target.otherWorkspace.id].map((workspaceId) =>
      post(app, membershipLeave, {
        slug: target.slug,
        token: target.admin.token,
        body: { workspace_id: workspaceId, user_id: person.userId },
      }),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(typeof (await lineOf(target, person))).toBe('string');
  const invitation = await createInvitation(
    target.organization,
    target.workspace.id,
    target.admin.userId!,
    person.login,
  );
  const fresh = await createSessionWithToken(person.accountId);
  expect(
    (
      await post(app, invitationAccept, {
        slug: target.slug,
        token: fresh.token,
        body: { invitation_id: invitation.id },
      })
    ).status,
  ).toBe(200);
  const old = await post(app, organizationInfo, { slug: target.slug, token: person.token, body: {} });
  expect(old.status).toBe(401);
  expect(await errorCodeOf(old)).toBe('organization_reauth_required');
  expect((await post(app, organizationInfo, { slug: target.slug, token: fresh.token, body: {} })).status).toBe(200);
});

for (const action of ['無効化', '最後の所属の除外'] as const) {
  test(`${action}の時計が前の線より遅れていても、線を巻き戻さない`, async () => {
    const target = await createTarget();
    const person = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ credentials_not_before: future })
          .where('organization_id', '=', target.organization.id)
          .where('id', '=', person.userId!),
      ),
    ]);
    const response =
      action === '無効化'
        ? await post(app, userDisable, {
            slug: target.slug,
            token: target.admin.token,
            body: { user_id: person.userId },
          })
        : await post(app, membershipLeave, {
            slug: target.slug,
            token: target.admin.token,
            body: { workspace_id: target.workspace.id, user_id: person.userId },
          });
    expect(response.status).toBe(200);
    expect(await lineOf(target, person)).toBe(future);
    if (action === '無効化') {
      expect(
        (
          await post(app, userEnable, {
            slug: target.slug,
            token: target.admin.token,
            body: { user_id: person.userId },
          })
        ).status,
      ).toBe(200);
      expect(await lineOf(target, person)).toBe(future);
    }
  });
}

for (const passedTime of [true, false]) {
  test(`発行元の時刻が読み取り後に変わったら発行せず確認日時も進めない（時刻の引数${passedTime ? 'あり' : 'なし'}）`, async () => {
    const account = await createAccount();
    const at = new Date(Date.now() - 60_000).toISOString();
    const session = await createSession(account.id, { created_at: at, api_token_seen_at: at });
    const db = commonDb(env);
    const racingDb = commonDb(env);
    const batch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      await racingDb.batch([
        racingDb.statement((q) =>
          q
            .updateTable('sessions')
            .set({ created_at: new Date(Date.now() - 30_000).toISOString() })
            .where('account_id', '=', account.id)
            .where('token_hash', '=', session.token_hash),
        ),
      ]);
      return batch(statements);
    });
    await expect(
      issueApiTokenWith(db, {
        accountId: account.id,
        sessionTokenHash: session.token_hash,
        ...(passedTime ? { sessionCreatedAt: at } : {}),
        name: '発行元時刻の競合',
        scope: 'read',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await tokenRowsOf(account.id)).toHaveLength(0);
    const row = await racingDb.first(
      racingDb.statement((q) =>
        q
          .selectFrom('sessions')
          .select('api_token_seen_at')
          .where('account_id', '=', account.id)
          .where('token_hash', '=', session.token_hash),
      ),
    );
    expect(row?.api_token_seen_at).toBe(at);
  });
}
