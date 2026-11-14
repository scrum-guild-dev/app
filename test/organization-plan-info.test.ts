// organization の応答の契約と上限（plan）。include_plan:true を指定した管理者にだけ返し、メンバーと別の組織には返さない。
// 運用者が契約を変えた後に読み直すと、新しい契約と上限が返ることも確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { organizationPlanUpdate } from '../src/shared/operations/operator/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { PLAN_LIMITS } from '../src/shared/organization-plan.ts';
import { createOrganization, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations);
const GIB = 1024 ** 3;

async function read(slug: string, token: string, body: { include_plan?: boolean } = { include_plan: true }) {
  const response = await post(app, organizationInfo, { slug, token, body });
  expect(response.status).toBe(200);
  return (await response.json()) as OutputOf<typeof organizationInfo>;
}

async function changePlan(
  slug: string,
  body: { plan: 'team' | 'business'; billing_interval: 'monthly' | 'yearly' },
  expected: { plan: 'team' | 'business'; billing_interval: 'monthly' | 'yearly' } | null,
) {
  const { token } = await withNewSession(await getOperator());
  const response = await post(app, organizationPlanUpdate, { token, body: { slug, ...body, expected } });
  expect(response.status).toBe(200);
}

describe('organization の契約と上限', () => {
  test('未契約の組織の管理者には、契約を null にして今の上限を返す', async () => {
    const organization = await createOrganization({ member_limit: 20, attachment_quota_bytes: 40 * GIB });
    const admin = await createPerson({ organization, admin: true });
    expect((await read(organization.slug, admin.token)).plan).toEqual({
      contract: null,
      member_limit: 20,
      attachment_quota_bytes: 40 * GIB,
    });
  });

  test('運用者が契約を変えると、管理者が読み直したときに新しい契約と上限が返る', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-11-30' });
    const admin = await createPerson({ organization, admin: true });

    await changePlan(organization.slug, { plan: 'team', billing_interval: 'monthly' }, null);
    expect((await read(organization.slug, admin.token)).plan).toEqual({
      contract: { plan: 'team', billing_interval: 'monthly', extra_10gb_units: 0, extra_50gb_units: 0 },
      ...PLAN_LIMITS.team,
    });

    await changePlan(
      organization.slug,
      { plan: 'business', billing_interval: 'yearly' },
      { plan: 'team', billing_interval: 'monthly' },
    );
    const after = await read(organization.slug, admin.token);
    expect(after.plan).toEqual({
      contract: { plan: 'business', billing_interval: 'yearly', extra_10gb_units: 0, extra_50gb_units: 0 },
      ...PLAN_LIMITS.business,
    });
    // 有料のプランにした時点でお試しは終わる
    expect(after.trial).toBeNull();
  });

  test('include_plan を指定しない呼び出し（組織の枠）には、管理者でも返さない', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    await changePlan(organization.slug, { plan: 'team', billing_interval: 'monthly' }, null);
    expect((await read(organization.slug, admin.token, {})).plan).toBeNull();
    expect((await read(organization.slug, admin.token, { include_plan: false })).plan).toBeNull();
  });

  test('追加容量の口数と個別のプランも、契約の行のとおりに返す', async () => {
    const organization = await createOrganization({ member_limit: 80, attachment_quota_bytes: 200 * GIB });
    const admin = await createPerson({ organization, admin: true });
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q.insertInto('organization_contracts').values({
          organization_id: organization.id,
          plan: 'custom',
          billing_interval: 'yearly',
          extra_10gb_units: 2,
          extra_50gb_units: 1,
          created_at: '2026-10-20T00:00:00.000Z',
          updated_at: '2026-10-20T00:00:00.000Z',
        }),
      ),
    ]);
    expect((await read(organization.slug, admin.token)).plan).toEqual({
      contract: { plan: 'custom', billing_interval: 'yearly', extra_10gb_units: 2, extra_50gb_units: 1 },
      member_limit: 80,
      attachment_quota_bytes: 200 * GIB,
    });
  });

  test('メンバーには契約も上限も返さない', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    const member = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    await changePlan(organization.slug, { plan: 'business', billing_interval: 'yearly' }, null);

    const result = await read(organization.slug, member.token);
    expect(result.plan).toBeNull();
    const body = JSON.stringify(result);
    expect(body).not.toContain('business');
    expect(body).not.toContain('yearly');
  });

  test('別の組織の管理者には、その組織の契約を返さない', async () => {
    const contracted = await createOrganization();
    const other = await createOrganization();
    await changePlan(contracted.slug, { plan: 'business', billing_interval: 'yearly' }, null);
    const admin = await createPerson({ organization: other, admin: true });

    const response = await post(app, organizationInfo, {
      slug: contracted.slug,
      token: admin.token,
      body: { include_plan: true },
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('business');
    // 自分の組織の応答には、別の組織の契約が混ざらない
    expect((await read(other.slug, admin.token)).plan?.contract).toBeNull();
  });
});
