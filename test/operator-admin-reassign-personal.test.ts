// 運用者による管理者の指名し直し（organization-admin-reassign）を、自分用の組織（kind = personal）で断る確かめ（#733）。
// 自分用は持ち主 1 人だけなので、2 人目の管理者は足さない。GitHub への問い合わせより前に 409 の conflict（reason: personal_organization）で断り、
// users の行も、招待の URL も作らない。チーム用は今まで通り
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { organizationAdminReassign as reassign } from '../src/shared/operations/operator/index.ts';
import { orgDb } from '../src/server/db/index.ts';
import { verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { createFakeGithub } from './auth/fake-github.ts';
import { createFakeGoogle } from './auth/fake-google.ts';
import { createLoginApp } from './auth/browser.ts';
import { githubUser } from './auth/helpers.ts';
import { createOrganization } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPersonalTarget, getOperator, withNewSession } from './operations/world.ts';

const github = createFakeGithub();
const google = createFakeGoogle();
const app = createLoginApp(github, google);

afterEach(() => {
  vi.restoreAllMocks();
});

async function operatorToken(): Promise<string> {
  return (await withNewSession(await getOperator())).token;
}

async function userIdsOf(organizationId: string) {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('users').select('id').where('organization_id', '=', organizationId).orderBy('id')),
  );
  return rows.map((row) => row.id);
}

type ErrorBody = { error: { code: string; details?: unknown } };

describe('自分用の組織の管理者の指名し直し', () => {
  test('Google のメールアドレスで呼ぶと 409（personal_organization）で、users の行も招待の URL も作らない', async () => {
    const target = await createPersonalTarget();
    const before = await userIdsOf(target.organization.id);
    const res = await post(app, reassign, {
      token: await operatorToken(),
      body: { slug: target.slug, admin: { provider: 'google', email: 'next-admin@example.com' } },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('conflict');
    expect(body.error.details).toEqual({ reason: 'personal_organization' });
    expect(JSON.stringify(body)).not.toContain('invite');
    expect(await userIdsOf(target.organization.id)).toEqual(before);
  });

  test('GitHub で呼ぶと、GitHub に問い合わせる前に 409（personal_organization）で断り、users の行を増やさない', async () => {
    const target = await createPersonalTarget();
    const before = await userIdsOf(target.organization.id);
    const nominee = githubUser(`personal-${crypto.randomUUID().slice(0, 6)}`);
    github.addUser(nominee);
    const callsBefore = github.calls.length;
    const res = await post(app, reassign, {
      token: await operatorToken(),
      body: {
        slug: target.slug,
        admin: { provider: 'github', username: nominee.login, login_subject: String(nominee.id) },
      },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('conflict');
    expect(body.error.details).toEqual({ reason: 'personal_organization' });
    expect(github.calls.length).toBe(callsBefore);
    expect(await userIdsOf(target.organization.id)).toEqual(before);
  });

  test('停止中の自分用も 409（personal_organization）で断る', async () => {
    const target = await createPersonalTarget({ suspended: true });
    const res = await post(app, reassign, {
      token: await operatorToken(),
      body: { slug: target.slug, admin: { provider: 'google', email: 'next-admin@example.com' } },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.details).toEqual({ reason: 'personal_organization' });
  });

  test('チーム用の組織は今まで通り、Google のメールアドレスで指名し直せる', async () => {
    const organization = await createOrganization();
    const res = await post(app, reassign, {
      token: await operatorToken(),
      body: { slug: organization.slug, admin: { provider: 'google', email: 'team-admin@example.com' } },
    });
    expect(res.status).toBe(200);
    expect((await userIdsOf(organization.id)).length).toBe(1);
  });
});
