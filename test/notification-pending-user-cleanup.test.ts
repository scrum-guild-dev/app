// #740 / PR #1137: ログイン待ちの管理者を物理削除するとき、本人の通知も同じ batch で先に消す。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { randomToken, sha256Hex } from '../src/server/auth/tokens.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { organizationAdminReassign } from '../src/shared/operations/operator/index.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp, FakeBrowser, loginEnv } from './auth/browser.ts';
import { githubUser, googleUser } from './auth/helpers.ts';
import {
  AT,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  uuidv7,
  type OrganizationFixture,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);

async function addNotification(organization: OrganizationFixture, userId: string, read = false) {
  const id = uuidv7();
  const db = orgDb(env, organization.verified);
  await db.batch([
    db.statement((q) =>
      q.insertInto('notifications').values({
        id,
        user_id: userId,
        kind: 'attachment_quota_warning',
        payload_json: JSON.stringify({ used_bytes: 900, quota_bytes: 1000 }),
        read_at: read ? AT : null,
        created_at: AT,
      }),
    ),
  ]);
  return id;
}

async function notificationIds(organization: OrganizationFixture, ids: string[]) {
  const db = orgDb(env, organization.verified);
  // 削除された users と結合すると孤児が見えなくなるので、通知を ID で直接読む。
  const rows = await db.rows(db.statement((q) => q.selectFrom('notifications').select('id').where('id', 'in', ids)));
  return rows.map((row) => row.id).sort();
}

async function userIds(organization: OrganizationFixture) {
  const db = orgDb(env, organization.verified);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('users').select('id').where('organization_id', '=', organization.id)),
  );
  return rows.map((row) => row.id);
}

async function pendingGoogle(organization: OrganizationFixture) {
  const token = randomToken();
  return createUser(organization, {
    account_id: null,
    is_admin: 1,
    login_provider: 'google',
    login_subject: null,
    login_email: `pending-${uuidv7()}@example.test`,
    claim_token_hash: await sha256Hex(token),
    claim_expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  });
}

function watchBatches() {
  const batches: string[][] = [];
  return {
    batches,
    env: envWithD1Hooks(loginEnv, { beforeBatch: (statements) => batches.push([...statements]) }),
  };
}

function expectNotificationsDeletedBeforeUsers(batches: string[][]) {
  const deletion = batches.find((statements) => statements.some((sql) => /^delete from "users"(?:\s|$)/i.test(sql)));
  expect(deletion, 'users の物理削除が実際に行われる batch').toBeDefined();
  const userIndex = deletion!.findIndex((sql) => /^delete from "users"(?:\s|$)/i.test(sql));
  const notificationIndex = deletion!.findIndex((sql) => /^delete from "notifications"(?:\s|$)/i.test(sql));
  expect(notificationIndex, '通知の削除も同じ batch にある').toBeGreaterThanOrEqual(0);
  expect(notificationIndex, '通知は users より前に消す').toBeLessThan(userIndex);
}

describe('ログイン待ちのユーザーの削除と通知', () => {
  test('運用者の指名し直しで消す待ちユーザーの既読・未読だけを消し、所属のある待ちユーザーと他組織の通知を残す', async () => {
    const organization = await createOrganization();
    const other = await createOrganization();
    const pending = await pendingGoogle(organization);
    const pendingGithub = await createUser(organization, { account_id: null, is_admin: 1 });
    const retained = await createPerson({ organization });
    const withMembership = await createUser(organization, { account_id: null, is_admin: 1 });
    const workspace = await createWorkspace(organization, retained.userId!);
    await createMembership(organization, workspace.id, withMembership.id);
    const otherPending = await pendingGoogle(other);
    const deleted = [
      await addNotification(organization, pending.id),
      await addNotification(organization, pending.id, true),
      await addNotification(organization, pendingGithub.id),
    ];
    const kept = [
      await addNotification(organization, retained.userId!),
      await addNotification(organization, withMembership.id),
      await addNotification(other, otherPending.id),
    ];
    const nominee = githubUser(`notify-admin-${uuidv7().slice(0, 8)}`);
    github.addUser(nominee);
    const watched = watchBatches();
    const response = await post(app, organizationAdminReassign, {
      env: watched.env,
      token: (await withNewSession(await getOperator())).token,
      body: {
        slug: organization.slug,
        admin: { provider: 'github', username: nominee.login, login_subject: String(nominee.id) },
      },
    });
    expect(response.status).toBe(200);
    const users = await userIds(organization);
    expect(users).not.toContain(pending.id);
    expect(users).not.toContain(pendingGithub.id);
    expect(users).toContain(retained.userId);
    expect(users).toContain(withMembership.id);
    expect(await notificationIds(organization, [...deleted, ...kept])).toEqual(kept.sort());
    expectNotificationsDeletedBeforeUsers(watched.batches);
  });

  test('Google の招待を既存アカウントへ統合するとき、消える待ち行の通知だけを消し、統合先と他組織の通知を残す', async () => {
    const organization = await createOrganization();
    const other = await createOrganization();
    const email = `merge-${uuidv7()}@example.test`;
    const googleProfile = googleUser('容量確認の管理者', { email });
    const existing = await createPerson({ organization, login: { provider: 'google', subject: googleProfile.sub } });
    const response = await post(app, organizationAdminReassign, {
      token: (await withNewSession(await getOperator())).token,
      body: { slug: organization.slug, admin: { provider: 'google', email } },
    });
    expect(response.status).toBe(200);
    const claimToken = new URL(((await response.json()) as { invite: { url: string } }).invite.url).hash.slice(1);
    const before = await userIds(organization);
    const pendingId = before.find((id) => id !== existing.userId);
    expect(pendingId).toBeDefined();
    const otherPending = await pendingGoogle(other);
    const deleted = [
      await addNotification(organization, pendingId!),
      await addNotification(organization, pendingId!, true),
    ];
    const kept = [await addNotification(organization, existing.userId!), await addNotification(other, otherPending.id)];
    const watched = watchBatches();
    const browser = new FakeBrowser(app, github, watched.env, undefined, google);
    const result = await browser.loginWithInvite(googleProfile, claimToken);
    expect(result.location).toBe(`/${organization.slug}`);
    expect(await userIds(organization)).toEqual([existing.userId]);
    expect(await notificationIds(organization, [...deleted, ...kept])).toEqual(kept.sort());
    expectNotificationsDeletedBeforeUsers(watched.batches);
  });
});
