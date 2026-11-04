// #675 の境界、旧版との互換、招待を使った順序のすり抜けを独立に確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { tokenCreate } from '../src/shared/operations/session/index.ts';
import { invitationAccept, membershipLeave } from '../src/shared/operations/workspace/index.ts';
import { createInvitation, createMembership, createOrganization, createUser, createWorkspace } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

async function cutoff(target: Target, person: Person, at: string) {
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ credentials_not_before: at })
        .where('organization_id', '=', target.organization.id)
        .where('id', '=', person.userId!),
    ),
  ]);
}

function info(target: Target, person: Person, bearer?: string) {
  return post(app, organizationInfo, {
    slug: target.slug,
    body: {},
    ...(bearer === undefined ? { token: person.token } : { bearer }),
  });
}

async function rejected(response: Response) {
  expect(response.status).toBe(401);
  expect(await errorCodeOf(response)).toBe('organization_reauth_required');
}

describe('組織の認証の線の境界と互換', () => {
  for (const delta of [-1, 0, 1]) {
    test(`Cookieの認証時刻が線${delta < 0 ? 'より1ms前' : delta === 0 ? 'と同時' : 'より1ms後'}`, async () => {
      const target = await createTarget();
      const at = Date.now() - 60_000;
      const person = await createPerson({
        organization: target.organization,
        admin: true,
        sessionOverrides: { created_at: new Date(at + delta).toISOString() },
      });
      await cutoff(target, person, new Date(at).toISOString());
      const response = await info(target, person);
      if (delta <= 0) await rejected(response);
      else expect(response.status).toBe(200);
    });

    test(`旧版が作った認証時刻NULLのトークンはcreated_atが線${delta < 0 ? 'より1ms前' : delta === 0 ? 'と同時' : 'より1ms後'}で判定`, async () => {
      const target = await createTarget();
      const person = await createPerson({ organization: target.organization, admin: true });
      const at = Date.now() - 60_000;
      const token = await insertApiToken(person.accountId, { createdAt: new Date(at + delta).toISOString() });
      await cutoff(target, person, new Date(at).toISOString());
      const response = await info(target, person, token.raw);
      if (delta <= 0) await rejected(response);
      else expect(response.status).toBe(200);
    });
  }

  test('セッションのcreated_atが読めないときは線を越えたことにしない', async () => {
    const target = await createTarget();
    const person = await createPerson({
      organization: target.organization,
      admin: true,
      sessionOverrides: { created_at: 'not-a-date' },
    });
    await cutoff(target, person, new Date(Date.now() - 60_000).toISOString());
    await rejected(await info(target, person));
  });

  test('旧版トークンのcreated_atが読めないときも線を越えたことにしない', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true });
    const token = await insertApiToken(person.accountId, { createdAt: 'not-a-date' });
    await cutoff(target, person, new Date(Date.now() - 60_000).toISOString());
    await rejected(await info(target, person, token.raw));
  });

  test('線の日時が読めないときも新しいセッションを通さない', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, admin: true });
    // UTC日時の形の制約には合うが、実在しない月。
    await cutoff(target, person, '2026-99-04T00:00:00.000Z');
    await rejected(await info(target, person));
  });

  for (const spelling of ['RFC', '4桁の小数'] as const) {
    test(`${spelling}のセッションから発行したトークンでも、Cookieと同じ認証時刻で拒む`, async () => {
      const target = await createTarget();
      const authenticatedMs = Math.floor(Date.now() / 1000) * 1000 - 60_000;
      const authenticatedAt =
        spelling === 'RFC'
          ? new Date(authenticatedMs).toUTCString()
          : new Date(authenticatedMs).toISOString().replace('.000Z', '.0009Z');
      const person = await createPerson({
        organization: target.organization,
        admin: true,
        sessionOverrides: { created_at: authenticatedAt },
      });
      await cutoff(target, person, new Date(authenticatedMs).toISOString());
      await rejected(await info(target, person));
      const issued = await post(app, tokenCreate, {
        token: person.token,
        body: { name: '認証時刻の表記の互換', scope: 'read' },
      });
      expect(issued.status).toBe(200);
      const token = (await issued.json()) as { token: string };
      await rejected(await info(target, person, token.token));
    });
  }

  test('承諾待ちの招待だけでは古い認証で承諾できず、招待も承諾済みにしない', async () => {
    const target = await createTarget();
    const person = await createPerson({
      organization: target.organization,
      sessionOverrides: { created_at: new Date(Date.now() - 60_000).toISOString() },
    });
    await cutoff(target, person, new Date().toISOString());
    const invitation = await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      person.login,
    );
    await rejected(
      await post(app, invitationAccept, {
        slug: target.slug,
        token: person.token,
        body: { invitation_id: invitation.id },
      }),
    );
    const db = orgDb(env, target.organization.verified);
    const row = await db.first(
      db.statement((q) =>
        q
          .selectFrom('invitations as i')
          .innerJoin('workspaces as w', 'w.id', 'i.workspace_id')
          .select('i.status')
          .where('i.id', '=', invitation.id)
          .where('w.organization_id', '=', target.organization.id),
      ),
    );
    expect(row?.status).toBe('pending');
  });

  test('他組織の所属が残っていても、リーダーによる最後の所属の除外はこの組織の認証を止める', async () => {
    const target = await createTarget();
    const person = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
      sessionOverrides: { created_at: new Date(Date.now() - 60_000).toISOString() },
    });
    const elsewhere = await createOrganization();
    const otherUser = await createUser(elsewhere, {
      account_id: person.accountId,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
    });
    const otherWorkspace = await createWorkspace(elsewhere, otherUser.id);
    await createMembership(elsewhere, otherWorkspace.id, otherUser.id);
    const removed = await post(app, membershipLeave, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, user_id: person.userId },
    });
    expect(removed.status).toBe(200);
    const invitation = await createInvitation(
      target.organization,
      target.workspace.id,
      target.admin.userId!,
      person.login,
    );
    await rejected(
      await post(app, invitationAccept, {
        slug: target.slug,
        token: person.token,
        body: { invitation_id: invitation.id },
      }),
    );
    expect((await post(app, organizationInfo, { slug: elsewhere.slug, token: person.token, body: {} })).status).toBe(
      200,
    );
  });
});
