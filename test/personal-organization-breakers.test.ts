// 自分用の組織（#733）の崩し。補償、応答の取りこぼし、停止中、越境、索引の最後の守りを確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createMyOrganization,
  createPersonalOrganization,
  myOrganizations,
  organizationInfo,
} from '../src/shared/operations/organization/index.ts';
import { userAdminUpdate } from '../src/shared/operations/organization/user.ts';
import { invitationCreate } from '../src/shared/operations/workspace/index.ts';
import {
  createAccount,
  createAccountLogin,
  createOrganization,
  createPersonalOrganizationRow,
  createSessionWithToken,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson, createPersonalTarget, testEnv } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;
const newSlug = () => `brk-${crypto.randomUUID().slice(0, 8)}-${counter++}`;

async function newMember(loginName = 'mio-hoshino') {
  const account = await createAccount();
  await createAccountLogin(account.id, { login_name: loginName });
  const { token } = await createSessionWithToken(account.id);
  return { accountId: account.id, token };
}
type Member = Awaited<ReturnType<typeof newMember>>;

const create = (member: Pick<Member, 'token'>, slug: string, options: { env?: Env } = {}) =>
  post(app, createPersonalOrganization, { token: member.token, body: { slug }, ...options });

async function organizationRow(slug: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('slug', '=', slug)));
}

async function organizationsOf(accountId: string) {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) => q.selectFrom('organizations').selectAll().where('created_by_account_id', '=', accountId)),
  );
}

async function usersOf(organizationId: string) {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  return db.rows(db.statement((q) => q.selectFrom('users').selectAll().where('organization_id', '=', organizationId)));
}

type ErrorBody = { error: { code: string; details?: unknown } };
const INSERT_USERS = 'insert into "users"';
const INSERT_ORGANIZATIONS = 'insert into "organizations"';
const includesStatement = (sqls: readonly string[], text: string) => sqls.some((sql) => sql.includes(text));

describe('最初の管理者の書き込みが失敗したときの補償', () => {
  test('自分用の行を消して 500 を返し、枠が戻って同じ入力の再送が 200 になる', async () => {
    const member = await newMember();
    const slug = newSlug();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_USERS)) throw new Error('組織の DB に書けない');
      },
    });

    const failed = await create(member, slug, { env: failing });
    expect(failed.status).toBe(500);
    expect(await errorCodeOf(failed)).toBe('internal');
    expect(await organizationRow(slug)).toBeUndefined();
    expect(await organizationsOf(member.accountId)).toHaveLength(0);

    const retried = await create(member, slug);
    expect(retried.status).toBe(200);
    const rows = await organizationsOf(member.accountId);
    expect(rows).toHaveLength(1);
    expect(await usersOf(rows[0]!.id)).toHaveLength(1);
  });

  test('補償は同じ人のチーム用（お試し）の組織を消さない', async () => {
    const member = await newMember();
    const teamSlug = newSlug();
    expect(
      (await post(app, createMyOrganization, { token: member.token, body: { slug: teamSlug, name: '青葉工房' } }))
        .status,
    ).toBe(200);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_USERS)) throw new Error('組織の DB に書けない');
      },
    });
    expect((await create(member, newSlug(), { env: failing })).status).toBe(500);
    const rows = await organizationsOf(member.accountId);
    expect(rows.map((row) => row.kind)).toEqual(['team']);
    expect(rows[0]!.slug).toBe(teamSlug);
  });

  test('自分用の失敗の後も、お試しの組織の枠は使われていない', async () => {
    const member = await newMember();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_USERS)) throw new Error('組織の DB に書けない');
      },
    });
    expect((await create(member, newSlug(), { env: failing })).status).toBe(500);
    const team = await post(app, createMyOrganization, {
      token: member.token,
      body: { slug: newSlug(), name: '青葉工房' },
    });
    expect(team.status).toBe(200);
  });

  test('組織の行の INSERT がコミットされた後に応答だけ失敗しても、成功として続け、管理者が1人書かれる', async () => {
    const member = await newMember();
    const slug = newSlug();
    const lostResponse = envWithD1Hooks(testEnv, {
      afterBatch: (sqls) => {
        if (includesStatement(sqls, INSERT_ORGANIZATIONS)) throw new Error('応答だけが届かない');
      },
    });
    const res = await create(member, slug, { env: lostResponse });
    expect(res.status).toBe(200);
    const row = (await organizationRow(slug))!;
    expect(row.kind).toBe('personal');
    expect(await usersOf(row.id)).toHaveLength(1);
  });
});

describe('同時の再送', () => {
  test('同じアカウントが同じ slug を同時に2回送っても、組織と管理者は1つずつで、負けた側は 409', async () => {
    const member = await newMember();
    const slug = newSlug();
    const responses = await Promise.all([create(member, slug), create(member, slug), create(member, slug)]);
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    for (const res of responses.filter((r) => r.status === 409)) {
      const reason = ((await res.json()) as ErrorBody).error.details as { reason: string };
      expect(['slug_taken', 'personal_limit']).toContain(reason.reason);
    }
    const rows = await organizationsOf(member.accountId);
    expect(rows).toHaveLength(1);
    expect(await usersOf(rows[0]!.id)).toHaveLength(1);
  });
});

describe('最も早いログイン', () => {
  test('ログインが複数あれば、最も早いログインの名前で管理者になる', async () => {
    const account = await createAccount();
    await createAccountLogin(account.id, { login_name: 'late-login', created_at: '2026-06-01T00:00:00.000Z' });
    await createAccountLogin(account.id, { login_name: 'early-login', created_at: '2026-01-01T00:00:00.000Z' });
    const { token } = await createSessionWithToken(account.id);
    const slug = newSlug();
    expect((await create({ token }, slug)).status).toBe(200);
    const row = (await organizationRow(slug))!;
    expect((await usersOf(row.id)).map((user) => user.name)).toEqual(['early-login']);
  });
});

describe('停止中の自分用', () => {
  test('入れる組織には出ず suspended に kind つきで出る。枠は残るので2つ目は personal_limit', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.updateTable('organizations').set({ suspended_at: '2026-10-01T00:00:00.000Z' }).where('slug', '=', slug),
      ),
    ]);

    const listed = await post(app, myOrganizations, { token: member.token });
    const body = (await listed.json()) as {
      organizations: unknown[];
      suspended: { slug: string; name: string; kind: string }[];
    };
    expect(body.organizations).toEqual([]);
    expect(body.suspended).toEqual([{ slug, name: '自分用', kind: 'personal' }]);

    const again = await create(member, newSlug());
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorBody).error.details).toEqual({ reason: 'personal_limit' });
  });
});

describe('チーム用の応答', () => {
  test('create-my-organization で作った組織は kind が team で、my-organizations と organization-info に出る', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect(
      (await post(app, createMyOrganization, { token: member.token, body: { slug, name: '青葉工房' } })).status,
    ).toBe(200);
    expect((await organizationRow(slug))!.kind).toBe('team');
    const listed = (await (await post(app, myOrganizations, { token: member.token })).json()) as {
      organizations: unknown[];
    };
    expect(listed.organizations).toEqual([{ slug, name: '青葉工房', kind: 'team' }]);
    const info = (await (await post(app, organizationInfo, { slug, token: member.token })).json()) as {
      organization: { kind: string };
    };
    expect(info.organization.kind).toBe('team');
  });

  test('自分用の organization-info は kind が personal で、お試しの期限が無い', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const info = (await (await post(app, organizationInfo, { slug, token: member.token })).json()) as {
      organization: { kind: string; trial_ends_on?: string | null };
    };
    expect(info.organization.kind).toBe('personal');
    expect(info.organization.trial_ends_on ?? null).toBeNull();
  });
});

describe('自分用の kind を他の組織の人に漏らさない', () => {
  test('別の組織の管理者の invitation-create と user-admin-update は 409 でなく、存在しない slug と同じ 404', async () => {
    const target = await createPersonalTarget();
    const outsider = await createLoginPerson();
    const missingSlug = newSlug();
    const inviteBody = {
      workspace_id: target.workspace.id,
      provider: 'google',
      email: 'haruka-aoi@example.com',
      role: 'member',
    };
    const inviteRes = await post(app, invitationCreate, { slug: target.slug, token: outsider.token, body: inviteBody });
    const inviteMissing = await post(app, invitationCreate, {
      slug: missingSlug,
      token: outsider.token,
      body: inviteBody,
    });
    expect(inviteRes.status).toBe(404);
    expect(await inviteRes.json()).toEqual(await inviteMissing.json());

    const adminBody = { user_id: target.admin.userId, is_admin: false };
    const adminRes = await post(app, userAdminUpdate, { slug: target.slug, token: outsider.token, body: adminBody });
    const adminMissing = await post(app, userAdminUpdate, {
      slug: missingSlug,
      token: outsider.token,
      body: adminBody,
    });
    expect(adminRes.status).toBe(404);
    expect(await adminRes.json()).toEqual(await adminMissing.json());
  });

  test('自分用で存在しない user_id を指名しても、404 でなく personal_organization の 409', async () => {
    const target = await createPersonalTarget();
    const res = await post(app, userAdminUpdate, {
      slug: target.slug,
      token: target.admin.token,
      body: { user_id: crypto.randomUUID(), is_admin: true },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.details).toEqual({ reason: 'personal_organization' });
  });
});

describe('部分 UNIQUE 索引の最後の守り', () => {
  test('同じ作成者の2つ目の personal 行は索引が断るが、team 行と作成者の無い personal 行は重ねて置ける', async () => {
    const account = await createAccount();
    await createPersonalOrganizationRow(account.id);
    await expect(createPersonalOrganizationRow(account.id)).rejects.toThrow();

    const db = commonDb(env);
    const teamCount = async () =>
      (
        await db.rows(
          db.statement((q) =>
            q.selectFrom('organizations').select('id').where('created_by_account_id', '=', account.id),
          ),
        )
      ).length;
    expect(await teamCount()).toBe(1);

    await createOrganization({ created_by_account_id: account.id });
    await createOrganization({ created_by_account_id: account.id });
    expect(await teamCount()).toBe(3);

    await createPersonalOrganizationRow(null as unknown as string);
    await createPersonalOrganizationRow(null as unknown as string);
  });

  test('kind の CHECK は team と personal 以外を断る', async () => {
    await expect(createOrganization({ kind: 'other' as 'team' })).rejects.toThrow();
  });
});
