// #675: 組織から止めた認証情報は、本人を戻しても復活しない。
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { organizationInfo, userDisable, userEnable } from '../src/shared/operations/organization/index.ts';
import { me, tokenCreate } from '../src/shared/operations/session/index.ts';
import { invitationAccept, membershipLeave } from '../src/shared/operations/workspace/index.ts';
import {
  createInvitation,
  createMembership,
  createOrganization,
  createSessionWithToken,
  createUser,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

async function oldMember(target: Target, admin = false) {
  return createPerson({
    organization: target.organization,
    admin,
    membership: { workspaceId: target.workspace.id, role: 'member' },
    sessionOverrides: { created_at: new Date(Date.now() - 60_000).toISOString() },
  });
}

function info(target: Target, person: Person, bearer?: string) {
  return post(app, organizationInfo, {
    slug: target.slug,
    ...(bearer === undefined ? { token: person.token } : { bearer }),
    body: {},
  });
}

async function disable(target: Target, person: Person) {
  expect(
    (
      await post(app, userDisable, {
        slug: target.slug,
        token: target.admin.token,
        body: { user_id: person.userId },
      })
    ).status,
  ).toBe(200);
}

async function enable(target: Target, person: Person) {
  expect(
    (
      await post(app, userEnable, {
        slug: target.slug,
        token: target.admin.token,
        body: { user_id: person.userId },
      })
    ).status,
  ).toBe(200);
}

async function remove(target: Target, person: Person, workspaceId = target.workspace.id, caller = target.admin) {
  expect(
    (
      await post(app, membershipLeave, {
        slug: target.slug,
        token: caller.token,
        body: { workspace_id: workspaceId, user_id: person.userId },
      })
    ).status,
  ).toBe(200);
}

async function issue(person: Person) {
  const response = await post(app, tokenCreate, {
    token: person.token,
    body: { name: '組織の認証の検査', scope: 'write' },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function fresh(person: Person): Promise<Person> {
  return { ...person, token: (await createSessionWithToken(person.accountId)).token };
}

async function rejectsOld(response: Response) {
  expect(response.status).toBe(401);
  expect(await errorCodeOf(response)).toBe('organization_reauth_required');
}

async function reinvite(target: Target, person: Person) {
  const invitation = await createInvitation(
    target.organization,
    target.workspace.id,
    target.admin.userId!,
    person.login,
  );
  const renewed = await fresh(person);
  expect(
    (
      await post(app, invitationAccept, {
        slug: target.slug,
        token: renewed.token,
        body: { invitation_id: invitation.id },
      })
    ).status,
  ).toBe(200);
  return renewed;
}

describe('組織で止めた認証の復活を防ぐ', () => {
  test('無効の間は404、有効に戻して再招待した後の古いセッションは401、新しいログインは200', async () => {
    const target = await createTarget();
    const person = await oldMember(target, true);
    expect((await info(target, person)).status).toBe(200);
    await disable(target, person);
    const disabled = await info(target, person);
    expect(disabled.status).toBe(404);
    expect(await errorCodeOf(disabled)).toBe('not_found');
    await enable(target, person);
    await reinvite(target, person);
    await rejectsOld(await info(target, person));
    expect((await info(target, await fresh(person))).status).toBe(200);
  });

  test('無効化前のAPIトークンは有効化後も拒否する', async () => {
    const target = await createTarget();
    const person = await oldMember(target, true);
    const token = await issue(person);
    await disable(target, person);
    await enable(target, person);
    await reinvite(target, person);
    await rejectsOld(await info(target, person, token));
  });

  test('無効化後に古いCookieから発行した新トークンでも線を越えられない', async () => {
    const target = await createTarget();
    const person = await oldMember(target, true);
    await disable(target, person);
    const token = await issue(person);
    await enable(target, person);
    await reinvite(target, person);
    await rejectsOld(await info(target, person, token));
    const renewed = await fresh(person);
    expect((await info(target, renewed, await issue(renewed))).status).toBe(200);
  });

  test('最後の所属から管理者が外し、新しいログインで再招待を承諾しても旧Cookieと旧トークンは復活しない', async () => {
    const target = await createTarget();
    const person = await oldMember(target);
    const token = await issue(person);
    await remove(target, person);
    expect((await info(target, person)).status).toBe(404);
    const renewed = await reinvite(target, person);
    expect((await info(target, renewed)).status).toBe(200);
    await rejectsOld(await info(target, person));
    await rejectsOld(await info(target, person, token));
  });

  test('最後の所属を失った後、古いCookieから発行したトークンも再招待の承諾後に拒否する', async () => {
    const target = await createTarget();
    const person = await oldMember(target);
    await remove(target, person);
    const token = await issue(person);
    await reinvite(target, person);
    await rejectsOld(await info(target, person, token));
  });

  test('別の組織と組織外の操作では旧Cookieも旧トークンも使い続けられる', async () => {
    const target = await createTarget();
    const person = await oldMember(target, true);
    const elsewhere = await createOrganization();
    await createUser(elsewhere, {
      account_id: person.accountId,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    const token = await issue(person);
    await disable(target, person);
    await enable(target, person);
    for (const credential of [{ token: person.token }, { bearer: token }]) {
      expect((await post(app, organizationInfo, { slug: elsewhere.slug, ...credential, body: {} })).status).toBe(200);
      expect((await post(app, me, { ...credential, body: {} })).status).toBe(200);
    }
  });

  test('他の今の所属が残る場合、1つのワークスペースから外しても認証し直しは不要', async () => {
    const target = await createTarget();
    const person = await oldMember(target);
    await createMembership(target.organization, target.otherWorkspace.id, person.userId!);
    const token = await issue(person);
    await remove(target, person);
    expect((await info(target, person)).status).toBe(200);
    expect((await info(target, person, token)).status).toBe(200);
  });

  test('自分で最後の所属から抜けた場合は再招待後も同じ認証を使える', async () => {
    const target = await createTarget();
    const person = await oldMember(target);
    await remove(target, person, target.workspace.id, person);
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
    expect((await info(target, person)).status).toBe(200);
  });

  test('usersの行も招待も無い人には組織の存在を404で隠す', async () => {
    const target = await createTarget();
    const outsider = await createPerson();
    const response = await info(target, outsider);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
  });
});
