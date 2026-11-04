// PR #816: 組織に入れる管理者の、最後の所属だけを外す操作は認証を止めない。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { organizationInfo, userAdminUpdate } from '../src/shared/operations/organization/index.ts';
import { tokenCreate } from '../src/shared/operations/session/index.ts';
import { invitationAccept, membershipLeave } from '../src/shared/operations/workspace/index.ts';
import { createInvitation, createSessionWithToken } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

async function issue(person: Person) {
  const response = await post(app, tokenCreate, {
    token: person.token,
    body: { name: '管理者の所属からの除外', scope: 'write' },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function remove(target: Target, caller: Person, person: Person) {
  const response = await post(app, membershipLeave, {
    slug: target.slug,
    token: caller.token,
    body: { workspace_id: target.workspace.id, user_id: person.userId },
  });
  expect(response.status).toBe(200);
}

describe('管理者は最後の所属を外されても組織に入れる', () => {
  for (const role of ['admin', 'leader'] as const) {
    for (const credential of ['cookie', 'token'] as const) {
      test(`${role}が管理者の最後の所属を外しても旧${credential}は200、認証の線はNULL`, async () => {
        const target = await createTarget();
        const person = await createPerson({
          organization: target.organization,
          admin: true,
          membership: { workspaceId: target.workspace.id, role: 'member' },
          sessionOverrides: { created_at: new Date(Date.now() - 60_000).toISOString() },
        });
        const token = await issue(person);
        await remove(target, target[role], person);
        const response = await post(app, organizationInfo, {
          slug: target.slug,
          ...(credential === 'cookie' ? { token: person.token } : { bearer: token }),
          body: {},
        });
        expect(response.status).toBe(200);
        const db = orgDb(env, target.organization.verified);
        const row = await db.first(
          db.statement((q) =>
            q
              .selectFrom('users')
              .select('credentials_not_before')
              .where('organization_id', '=', target.organization.id)
              .where('id', '=', person.userId!),
          ),
        );
        expect(row?.credentials_not_before).toBeNull();
      });
    }
  }

  test('管理者でない人の最後の所属を外した場合は、再招待後も旧Cookieと旧トークンを拒否する', async () => {
    const target = await createTarget();
    const person = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
      sessionOverrides: { created_at: new Date(Date.now() - 60_000).toISOString() },
    });
    const token = await issue(person);
    await remove(target, target.leader, person);
    const invitation = await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      person.login,
    );
    const renewed = await createSessionWithToken(person.accountId);
    expect(
      (
        await post(app, invitationAccept, {
          slug: target.slug,
          token: renewed.token,
          body: { invitation_id: invitation.id },
        })
      ).status,
    ).toBe(200);
    for (const credential of [{ token: person.token }, { bearer: token }]) {
      const response = await post(app, organizationInfo, { slug: target.slug, ...credential, body: {} });
      expect(response.status).toBe(401);
      expect(await errorCodeOf(response)).toBe('organization_reauth_required');
    }
  });
});

test('最後の所属を外された管理者の指名解除単独は失効対象外で、再招待後も旧Cookieと旧トークンは使える', async () => {
  const target = await createTarget();
  const person = await createPerson({
    organization: target.organization,
    admin: true,
    membership: { workspaceId: target.workspace.id, role: 'member' },
    sessionOverrides: { created_at: new Date(Date.now() - 60_000).toISOString() },
  });
  const token = await issue(person);
  await remove(target, target.admin, person);
  expect(
    (
      await post(app, userAdminUpdate, {
        slug: target.slug,
        token: target.admin.token,
        body: { user_id: person.userId, is_admin: false },
      })
    ).status,
  ).toBe(200);
  const invitation = await createInvitation(
    target.organization,
    target.workspace.id,
    target.admin.userId!,
    person.login,
  );
  expect(
    (
      await post(app, invitationAccept, {
        slug: target.slug,
        token: person.token,
        body: { invitation_id: invitation.id },
      })
    ).status,
  ).toBe(200);
  for (const credential of [{ token: person.token }, { bearer: token }]) {
    expect((await post(app, organizationInfo, { slug: target.slug, ...credential, body: {} })).status).toBe(200);
  }
});
