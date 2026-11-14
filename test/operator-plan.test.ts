// 運用者の組織の契約の変更（organization-plan-update）と、契約のある組織での上限の変更（organization-quota-update）の結合テスト。
// 組織の分離と権限の一覧のテスト（test/operation-registry.test.ts）は、この操作も回す。
// ここでは、契約に固有の振る舞い（上限が契約から決まる、お試しが終わる、停止は解かない、自分用を断る、同じ契約、競合の 409、
// 追加容量の口数が残る、履歴の行と文、履歴を書けなくても成功すること、上限の変更を断ること）を確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  listOrganizations,
  organizationPlanUpdate,
  organizationQuotaUpdate,
} from '../src/shared/operations/operator/index.ts';
import { organizationHistory } from '../src/shared/operations/organization/organization-history.ts';
import { contractLimits, PLAN_LIMITS, type BillingInterval, type TeamPlan } from '../src/shared/organization-plan.ts';
import { createOrganization, createUser } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, getOperator, OPERATOR_LOGIN_ID, testEnv, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.restoreAllMocks();
});

const GIB = 1024 ** 3;
const TEAM = { member_limit: 15, attachment_quota_bytes: 30 * GIB };
const BUSINESS = { member_limit: 50, attachment_quota_bytes: 100 * GIB };
const AT = '2026-10-20T00:00:00.000Z';

const operatorToken = async () => (await withNewSession(await getOperator())).token;

type Terms = { plan: TeamPlan; billing_interval: BillingInterval };
type Expected = { plan: 'personal' | 'team' | 'business' | 'custom'; billing_interval: BillingInterval } | null;

async function organizationRow(id: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', id)));
}

async function contractRow(organizationId: string) {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q.selectFrom('organization_contracts').selectAll().where('organization_id', '=', organizationId),
    ),
  );
}

async function insertContract(
  organizationId: string,
  contract: { plan: string; billing_interval: string; extra_10gb_units?: number; extra_50gb_units?: number },
) {
  const db = commonDb(env);
  await db.batch([
    db.statement((q) =>
      q.insertInto('organization_contracts').values({
        organization_id: organizationId,
        extra_10gb_units: 0,
        extra_50gb_units: 0,
        created_at: AT,
        updated_at: AT,
        ...contract,
      }),
    ),
  ]);
}

async function changeLogsOf(organizationId: string) {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('entity_type', '=', 'organization')
        .orderBy('created_at'),
    ),
  );
}

// expected（画面が見ていた前の契約）を渡さなければ、呼ぶ前の今の契約を渡す（画面が最新の一覧から開いたときと同じ）
async function changePlanBy(
  token: string,
  slug: string,
  terms: Terms,
  options: { expected?: Expected; env?: Env } = {},
) {
  let expected = options.expected;
  if (expected === undefined) {
    const db = commonDb(env);
    const row = await db.first(
      db.statement((q) =>
        q
          .selectFrom('organizations')
          .leftJoin('organization_contracts', 'organization_contracts.organization_id', 'organizations.id')
          .select(['organization_contracts.plan', 'organization_contracts.billing_interval'])
          .where('organizations.slug', '=', slug),
      ),
    );
    expected =
      row?.plan == null || row.billing_interval == null
        ? null
        : ({ plan: row.plan, billing_interval: row.billing_interval } as Expected);
  }
  return post(app, organizationPlanUpdate, { token, body: { slug, ...terms, expected }, env: options.env });
}

describe('契約から決まる上限', () => {
  test('チームは 15 人と 30 GB、ビジネスは 50 人と 100 GB、パーソナルは 1 人と 1 GB。追加容量は口数を足す', () => {
    expect(PLAN_LIMITS.team).toEqual(TEAM);
    expect(PLAN_LIMITS.business).toEqual(BUSINESS);
    expect(PLAN_LIMITS.personal).toEqual({ member_limit: 1, attachment_quota_bytes: GIB });
    expect(contractLimits({ plan: 'business', extra_10gb_units: 2, extra_50gb_units: 1 })).toEqual({
      member_limit: 50,
      attachment_quota_bytes: 170 * GIB,
    });
    expect(contractLimits({ plan: 'personal', extra_10gb_units: 1, extra_50gb_units: 0 })).toEqual({
      member_limit: 1,
      attachment_quota_bytes: 11 * GIB,
    });
  });
});

describe('契約の変更', () => {
  test('未契約の組織をチーム・月払いにすると、契約の行ができ、上限がチームの値になり、一覧に契約が出る', async () => {
    const organization = await createOrganization({ member_limit: 30, attachment_quota_bytes: 60 * GIB });
    const token = await operatorToken();
    const res = await changePlanBy(token, organization.slug, { plan: 'team', billing_interval: 'monthly' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      slug: organization.slug,
      contract: { plan: 'team', billing_interval: 'monthly', extra_10gb_units: 0, extra_50gb_units: 0 },
      ...TEAM,
      trial_ends_on: null,
    });
    expect(await contractRow(organization.id)).toMatchObject({
      plan: 'team',
      billing_interval: 'monthly',
      extra_10gb_units: 0,
      extra_50gb_units: 0,
    });
    const row = await organizationRow(organization.id);
    expect(row).toMatchObject(TEAM);
    expect(row?.updated_at).not.toBe(organization.updated_at);

    const listed = (await (await post(app, listOrganizations, { token })).json()) as {
      organizations: { slug: string; contract: unknown; seats: { limit: number }; attachment_quota_bytes: number }[];
    };
    const item = listed.organizations.find((entry) => entry.slug === organization.slug);
    expect(item?.contract).toEqual({
      plan: 'team',
      billing_interval: 'monthly',
      extra_10gb_units: 0,
      extra_50gb_units: 0,
    });
    expect(item?.seats.limit).toBe(15);
    expect(item?.attachment_quota_bytes).toBe(30 * GIB);
  });

  test('未契約の組織の一覧の契約は null', async () => {
    const organization = await createOrganization();
    const listed = (await (await post(app, listOrganizations, { token: await operatorToken() })).json()) as {
      organizations: { slug: string; contract: unknown }[];
    };
    expect(listed.organizations.find((entry) => entry.slug === organization.slug)?.contract).toBeNull();
  });

  test('チームからビジネス・年払いに変えると 50 人と 100 GB、チームに戻すと 15 人と 30 GB', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    expect((await changePlanBy(token, organization.slug, { plan: 'team', billing_interval: 'monthly' })).status).toBe(
      200,
    );
    expect(
      (await changePlanBy(token, organization.slug, { plan: 'business', billing_interval: 'yearly' })).status,
    ).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject(BUSINESS);
    expect(await contractRow(organization.id)).toMatchObject({ plan: 'business', billing_interval: 'yearly' });
    expect((await changePlanBy(token, organization.slug, { plan: 'team', billing_interval: 'yearly' })).status).toBe(
      200,
    );
    expect(await organizationRow(organization.id)).toMatchObject(TEAM);
  });

  test('人数がチームの上限を超える組織もチームに下げられ、今いる人は残り、一覧の人数が上限を超える', async () => {
    const organization = await createOrganization(BUSINESS);
    await insertContract(organization.id, { plan: 'business', billing_interval: 'monthly' });
    // 無効でない管理者は人数に数える。16 人でチームの上限（15 人）を超える
    for (let index = 0; index < 16; index++) await createUser(organization, { is_admin: 1 });
    const token = await operatorToken();
    const res = await changePlanBy(token, organization.slug, { plan: 'team', billing_interval: 'monthly' });
    expect(res.status).toBe(200);
    expect((await organizationRow(organization.id))?.member_limit).toBe(15);
    // 今いる人は消さない。新しい招待と管理者への指名が止まるのは、人数の上限の既存の扱い（test/invitation などが確かめる）
    const db = orgDb(env, verifiedOrganizationForTest(organization.id));
    const users = await db.rows(
      db.statement((q) => q.selectFrom('users').select('id').where('organization_id', '=', organization.id)),
    );
    expect(users).toHaveLength(16);
    const listed = (await (await post(app, listOrganizations, { token })).json()) as {
      organizations: { slug: string; seats: { used: number; limit: number } }[];
    };
    expect(listed.organizations.find((entry) => entry.slug === organization.slug)?.seats).toEqual({
      used: 16,
      limit: 15,
    });
  });

  test('お試し中の組織を契約にすると、お試しの期限を空にする', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-12-01' });
    const res = await changePlanBy(await operatorToken(), organization.slug, {
      plan: 'team',
      billing_interval: 'monthly',
    });
    expect(res.status).toBe(200);
    expect((await organizationRow(organization.id))?.trial_ends_on).toBeNull();
  });

  test('期限切れで止まっている組織を契約にしても、停止したまま（再開は別の操作）', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-01', suspended_at: AT });
    const res = await changePlanBy(await operatorToken(), organization.slug, {
      plan: 'business',
      billing_interval: 'yearly',
    });
    expect(res.status).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject({
      ...BUSINESS,
      trial_ends_on: null,
      suspended_at: AT,
      purge_on: null,
    });
  });

  test('自分用の組織は 409 の conflict（reason: personal_organization）で、書かない', async () => {
    const organization = await createOrganization({ kind: 'personal', member_limit: 1, attachment_quota_bytes: GIB });
    const res = await changePlanBy(await operatorToken(), organization.slug, {
      plan: 'team',
      billing_interval: 'monthly',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'conflict', details: { reason: 'personal_organization' } },
    });
    expect(await contractRow(organization.id)).toBeUndefined();
    expect(await organizationRow(organization.id)).toMatchObject({ member_limit: 1, attachment_quota_bytes: GIB });
  });

  test('解約で消す予定日を過ぎた組織は 409 の purge_due で、契約を足さない。予定日の当日までと一時的な停止は書ける', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const dateOf = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
    const token = await operatorToken();
    const due = await createOrganization({ suspended_at: AT, purge_on: dateOf(-1) });
    const res = await changePlanBy(token, due.slug, { plan: 'team', billing_interval: 'monthly' });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('purge_due');
    expect(await contractRow(due.id)).toBeUndefined();
    expect(await changeLogsOf(due.id)).toEqual([]);

    const notYet = await createOrganization({ suspended_at: AT, purge_on: dateOf(1) });
    expect((await changePlanBy(token, notYet.slug, { plan: 'team', billing_interval: 'monthly' })).status).toBe(200);
    const temporary = await createOrganization({ suspended_at: AT });
    expect((await changePlanBy(token, temporary.slug, { plan: 'team', billing_interval: 'monthly' })).status).toBe(200);
  });

  test('読んだ後に消す予定日を過ぎた（解約に切り替えられた）組織には、契約を足さず、上限も変えない', async () => {
    const organization = await createOrganization({ suspended_at: AT });
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('"organization_contracts"') || !sql.includes('"trial_ends_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q.updateTable('organizations').set({ purge_on: '2000-01-01' }).where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'business', billing_interval: 'yearly' },
      { env: racing },
    );
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await contractRow(organization.id)).toBeUndefined();
    expect(await organizationRow(organization.id)).toMatchObject(TEAM);
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('無い slug は 404 の not_found', async () => {
    const res = await changePlanBy(
      await operatorToken(),
      'no-such-organization',
      { plan: 'team', billing_interval: 'monthly' },
      { expected: null },
    );
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('チームとビジネス以外のプランと、知らない支払いの周期は 400 の invalid_input', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    for (const body of [
      { plan: 'personal', billing_interval: 'monthly' },
      { plan: 'custom', billing_interval: 'monthly' },
      { plan: 'team', billing_interval: 'weekly' },
    ]) {
      const res = await post(app, organizationPlanUpdate, {
        token,
        body: { slug: organization.slug, ...body, expected: null },
      });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    expect(await contractRow(organization.id)).toBeUndefined();
  });

  test('今と同じ契約なら何も書かず、履歴も残さず、今の値を返す', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-12-01' });
    await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
    // 前の値が違っても、今の契約が送った値と同じなら同じ扱い
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'team', billing_interval: 'monthly' },
      { expected: { plan: 'business', billing_interval: 'yearly' } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      slug: organization.slug,
      contract: { plan: 'team', billing_interval: 'monthly', extra_10gb_units: 0, extra_50gb_units: 0 },
      ...TEAM,
      trial_ends_on: '2026-12-01',
    });
    expect(await contractRow(organization.id)).toMatchObject({ updated_at: AT });
    expect((await organizationRow(organization.id))?.updated_at).toBe(organization.updated_at);
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('画面が見ていた前の契約（expected）と今の契約が違えば 409 で、書かない', async () => {
    const organization = await createOrganization();
    // 確認を開いた後に、別の運用者がビジネスで契約していた
    await insertContract(organization.id, { plan: 'business', billing_interval: 'monthly' });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'team', billing_interval: 'yearly' },
      { expected: null },
    );
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await contractRow(organization.id)).toMatchObject({ plan: 'business', billing_interval: 'monthly' });
    expect(await organizationRow(organization.id)).toMatchObject({ updated_at: organization.updated_at });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('前の契約がプランか支払いの周期の片方だけ違っても 409 で、書かない', async () => {
    const organization = await createOrganization();
    await insertContract(organization.id, { plan: 'team', billing_interval: 'yearly' });
    const token = await operatorToken();
    for (const expected of [
      { plan: 'team', billing_interval: 'monthly' },
      { plan: 'business', billing_interval: 'yearly' },
    ] as const) {
      const res = await changePlanBy(
        token,
        organization.slug,
        { plan: 'business', billing_interval: 'monthly' },
        { expected },
      );
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('conflict');
    }
    expect(await contractRow(organization.id)).toMatchObject({
      plan: 'team',
      billing_interval: 'yearly',
      updated_at: AT,
    });
    expect(await organizationRow(organization.id)).toMatchObject({ ...TEAM, updated_at: organization.updated_at });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  // 読んだ直後に、別の運用者の書き込みを差し込む
  function racingAfterRead(write: () => Promise<void>) {
    const state = { armed: true };
    const env = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!state.armed || !sql.includes('"organization_contracts"') || !sql.includes('"trial_ends_on"')) return;
        state.armed = false;
        await write();
      },
    });
    return { env, state };
  }

  test('契約を読んだ後に別の運用者がプランだけを変えていれば 409 で、先の契約を書き換えない', async () => {
    const organization = await createOrganization();
    await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
    const racing = racingAfterRead(async () => {
      const db = commonDb(env);
      await db.batch([
        db.statement((q) =>
          q
            .updateTable('organization_contracts')
            .set({ plan: 'business' })
            .where('organization_id', '=', organization.id),
        ),
      ]);
    });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'team', billing_interval: 'yearly' },
      { env: racing.env },
    );
    expect(racing.state.armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await contractRow(organization.id)).toMatchObject({ plan: 'business', billing_interval: 'monthly' });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('読んだ後に別の運用者が上限を値で変えていれば 409 で、契約を足さず、その上限を書き換えない', async () => {
    const organization = await createOrganization({ attachment_quota_bytes: 200 * GIB });
    const racing = racingAfterRead(async () => {
      const db = commonDb(env);
      await db.batch([
        db.statement((q) =>
          q
            .updateTable('organizations')
            .set({ member_limit: 20, attachment_quota_bytes: 20 * GIB, attachment_quota_warned_at: AT })
            .where('id', '=', organization.id),
        ),
      ]);
    });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'business', billing_interval: 'monthly' },
      { env: racing.env },
    );
    expect(racing.state.armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await contractRow(organization.id)).toBeUndefined();
    expect(await organizationRow(organization.id)).toMatchObject({
      member_limit: 20,
      attachment_quota_bytes: 20 * GIB,
      attachment_quota_warned_at: AT,
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('読んだ後に別の運用者が追加容量の口数を変えていれば 409 で、契約と上限を書き換えない', async () => {
    const organization = await createOrganization();
    await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
    const racing = racingAfterRead(async () => {
      const db = commonDb(env);
      // 口数を変える操作（#1191）と同じく、契約の口数と organizations の容量を一緒に書く
      await db.batch([
        db.statement((q) =>
          q
            .updateTable('organization_contracts')
            .set({ extra_10gb_units: 2 })
            .where('organization_id', '=', organization.id),
        ),
        db.statement((q) =>
          q
            .updateTable('organizations')
            .set({ attachment_quota_bytes: 50 * GIB })
            .where('id', '=', organization.id),
        ),
      ]);
    });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'business', billing_interval: 'monthly' },
      { env: racing.env },
    );
    expect(racing.state.armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await contractRow(organization.id)).toMatchObject({ plan: 'team', extra_10gb_units: 2 });
    expect(await organizationRow(organization.id)).toMatchObject({
      member_limit: 15,
      attachment_quota_bytes: 50 * GIB,
    });
  });

  // 契約を書く条件の列を1つずつ外したときに落ちるよう、読んだ後に1列だけを変える
  for (const [label, column, value] of [
    ['人数の上限だけ', 'member_limit', 20],
    ['添付ファイルの上限だけ', 'attachment_quota_bytes', 40 * GIB],
  ] as const) {
    for (const contracted of [false, true]) {
      test(`読んだ後に${label}が変わっていれば、${contracted ? '契約のある' : '未契約の'}組織でも 409 で書かない`, async () => {
        const organization = await createOrganization();
        if (contracted) await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
        const racing = racingAfterRead(async () => {
          const db = commonDb(env);
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('organizations')
                .set({ [column]: value })
                .where('id', '=', organization.id),
            ),
          ]);
        });
        const res = await changePlanBy(
          await operatorToken(),
          organization.slug,
          { plan: 'business', billing_interval: 'monthly' },
          { env: racing.env },
        );
        expect(racing.state.armed).toBe(false);
        expect(res.status).toBe(409);
        expect((await organizationRow(organization.id))?.[column]).toBe(value);
        if (contracted) expect(await contractRow(organization.id)).toMatchObject({ plan: 'team', updated_at: AT });
        else expect(await contractRow(organization.id)).toBeUndefined();
      });
    }
  }

  for (const column of ['extra_10gb_units', 'extra_50gb_units'] as const) {
    test(`読んだ後に契約の ${column} だけが変わっていれば 409 で、契約を書き換えない`, async () => {
      const organization = await createOrganization();
      await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
      const racing = racingAfterRead(async () => {
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('organization_contracts')
              .set({ [column]: 1 })
              .where('organization_id', '=', organization.id),
          ),
        ]);
      });
      const res = await changePlanBy(
        await operatorToken(),
        organization.slug,
        { plan: 'business', billing_interval: 'monthly' },
        { env: racing.env },
      );
      expect(racing.state.armed).toBe(false);
      expect(res.status).toBe(409);
      expect(await contractRow(organization.id)).toMatchObject({ plan: 'team', [column]: 1 });
      expect(await organizationRow(organization.id)).toMatchObject(TEAM);
    });
  }

  test('未契約と読んだ後に別の運用者が先に契約を付けていれば 409 で、先の契約と上限を書き換えない', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-12-01' });
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('"organization_contracts"') || !sql.includes('"trial_ends_on"')) return;
        armed = false;
        await insertContract(organization.id, { plan: 'business', billing_interval: 'monthly' });
      },
    });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'team', billing_interval: 'yearly' },
      { env: racing },
    );
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await contractRow(organization.id)).toMatchObject({ plan: 'business', billing_interval: 'monthly' });
    // 契約が書けなかったので、上限とお試しの期限も変えない
    expect(await organizationRow(organization.id)).toMatchObject({ ...TEAM, trial_ends_on: '2026-12-01' });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('契約を読んだ後に別の運用者が先に変えていれば 409 で、先の契約と上限を書き換えない', async () => {
    const organization = await createOrganization();
    await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('"organization_contracts"') || !sql.includes('"trial_ends_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('organization_contracts')
              .set({ billing_interval: 'yearly' })
              .where('organization_id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'business', billing_interval: 'monthly' },
      { env: racing },
    );
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await contractRow(organization.id)).toMatchObject({ plan: 'team', billing_interval: 'yearly' });
    expect(await organizationRow(organization.id)).toMatchObject(TEAM);
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('追加容量の口数は残し、添付ファイルの上限に足し続ける', async () => {
    const organization = await createOrganization({ attachment_quota_bytes: 100 * GIB });
    await insertContract(organization.id, {
      plan: 'team',
      billing_interval: 'monthly',
      extra_10gb_units: 2,
      extra_50gb_units: 1,
    });
    const res = await changePlanBy(await operatorToken(), organization.slug, {
      plan: 'business',
      billing_interval: 'monthly',
    });
    expect(res.status).toBe(200);
    expect(await contractRow(organization.id)).toMatchObject({ extra_10gb_units: 2, extra_50gb_units: 1 });
    expect(await organizationRow(organization.id)).toMatchObject({
      member_limit: 50,
      attachment_quota_bytes: 170 * GIB,
    });
  });

  test('添付ファイルの上限を上げたら 80% の通知の日時を空に戻し、下げたときは触らない', async () => {
    const raised = await createOrganization({
      attachment_quota_warned_at: AT,
      attachment_quota_warning_pending_at: AT,
    });
    const token = await operatorToken();
    expect((await changePlanBy(token, raised.slug, { plan: 'business', billing_interval: 'monthly' })).status).toBe(
      200,
    );
    expect(await organizationRow(raised.id)).toMatchObject({
      attachment_quota_warned_at: null,
      attachment_quota_warning_pending_at: null,
    });

    const lowered = await createOrganization({ ...BUSINESS, attachment_quota_warned_at: AT });
    expect((await changePlanBy(token, lowered.slug, { plan: 'team', billing_interval: 'monthly' })).status).toBe(200);
    expect((await organizationRow(lowered.id))?.attachment_quota_warned_at).toBe(AT);

    // 容量が変わらない契約（未契約の 30 GB からチーム、ビジネスの周期だけの変更）でも触らない
    const same = await createOrganization({ attachment_quota_warned_at: AT, attachment_quota_warning_pending_at: AT });
    expect((await changePlanBy(token, same.slug, { plan: 'team', billing_interval: 'monthly' })).status).toBe(200);
    expect(await organizationRow(same.id)).toMatchObject({
      attachment_quota_warned_at: AT,
      attachment_quota_warning_pending_at: AT,
    });
    const yearly = await createOrganization({ ...BUSINESS, attachment_quota_warned_at: AT });
    await insertContract(yearly.id, { plan: 'business', billing_interval: 'monthly' });
    expect((await changePlanBy(token, yearly.slug, { plan: 'business', billing_interval: 'yearly' })).status).toBe(200);
    expect((await organizationRow(yearly.id))?.attachment_quota_warned_at).toBe(AT);
  });

  test('片方の組織の契約を変えても、もう片方の組織の行、契約、履歴は変わらない', async () => {
    const changed = await createOrganization();
    const other = await createOrganization();
    await insertContract(other.id, { plan: 'team', billing_interval: 'monthly' });
    const otherBefore = await organizationRow(other.id);
    expect(
      (await changePlanBy(await operatorToken(), changed.slug, { plan: 'business', billing_interval: 'yearly' }))
        .status,
    ).toBe(200);
    expect(await organizationRow(other.id)).toEqual(otherBefore);
    expect(await contractRow(other.id)).toMatchObject({ plan: 'team', billing_interval: 'monthly', updated_at: AT });
    expect(await changeLogsOf(other.id)).toEqual([]);
  });
});

describe('契約のある組織の上限の変更', () => {
  test('organization-quota-update は 409 の conflict（reason: plan_managed）で、書かない', async () => {
    const organization = await createOrganization();
    await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
    const res = await post(app, organizationQuotaUpdate, {
      token: await operatorToken(),
      body: { slug: organization.slug, ...BUSINESS, expected: TEAM },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'plan_managed' } } });
    expect(await organizationRow(organization.id)).toMatchObject({ ...TEAM, updated_at: organization.updated_at });
  });

  test('上限を読んだ後に別の運用者が契約を付けていれば 409 で、契約の上限を書き換えない', async () => {
    const organization = await createOrganization();
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"attachment_quota_warned_at"')) return;
        armed = false;
        await insertContract(organization.id, { plan: 'team', billing_interval: 'monthly' });
      },
    });
    const res = await post(app, organizationQuotaUpdate, {
      token: await operatorToken(),
      body: { slug: organization.slug, ...BUSINESS, expected: TEAM },
      env: racing,
    });
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await organizationRow(organization.id)).toMatchObject(TEAM);
  });
});

describe('変更の履歴', () => {
  test('運用者の操作として organization の update の行を残し、契約の組と変わった列の前後の値を書く', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-12-01', attachment_quota_warned_at: AT });
    const token = await operatorToken();
    expect(
      (await changePlanBy(token, organization.slug, { plan: 'business', billing_interval: 'monthly' })).status,
    ).toBe(200);
    // 支払いの周期だけを変える。上限は変わらない
    expect(
      (await changePlanBy(token, organization.slug, { plan: 'business', billing_interval: 'yearly' })).status,
    ).toBe(200);

    const [started, intervalOnly] = await changeLogsOf(organization.id);
    expect(started).toMatchObject({
      organization_id: organization.id,
      workspace_id: null,
      actor_user_id: null,
      operator: OPERATOR_LOGIN_ID,
      entity_type: 'organization',
      entity_id: organization.id,
      action: 'update',
    });
    expect(JSON.parse(started!.changes_json)).toEqual({
      plan: [null, 'business'],
      billing_interval: [null, 'monthly'],
      member_limit: [15, 50],
      attachment_quota_bytes: [30 * GIB, 100 * GIB],
      trial_ends_on: ['2026-12-01', null],
      attachment_quota_warned_at: [AT, null],
    });
    expect(JSON.parse(intervalOnly!.changes_json)).toEqual({
      plan: ['business', 'business'],
      billing_interval: ['monthly', 'yearly'],
    });
  });

  test('組織の変更の履歴（organization-history）に、運用者のプランの変更として前後の契約が出る', async () => {
    const target = await createTarget();
    const token = await operatorToken();
    expect((await changePlanBy(token, target.slug, { plan: 'team', billing_interval: 'monthly' })).status).toBe(200);
    expect((await changePlanBy(token, target.slug, { plan: 'business', billing_interval: 'yearly' })).status).toBe(200);
    const entries = (
      (await (await post(app, organizationHistory, { slug: target.slug, token: target.admin.token })).json()) as {
        entries: { actor: { kind: string }; event: unknown }[];
      }
    ).entries;
    // 新しい順
    expect(entries[0]).toMatchObject({
      actor: { kind: 'operator' },
      event: {
        kind: 'organization_plan_changed',
        from: { plan: 'team', billing_interval: 'monthly' },
        to: { plan: 'business', billing_interval: 'yearly' },
      },
    });
    expect(entries[1]).toMatchObject({
      actor: { kind: 'operator' },
      event: { kind: 'organization_plan_changed', from: null, to: { plan: 'team', billing_interval: 'monthly' } },
    });
  });

  test('履歴を書けなくても変更は成功し、ログに組織の ID、前後の値、日時、例外の名前だけを残す', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const organization = await createOrganization();
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "change_logs"'))) throw new Error('secret SQL detail');
      },
    });
    const res = await changePlanBy(
      await operatorToken(),
      organization.slug,
      { plan: 'business', billing_interval: 'yearly' },
      { env: failing },
    );
    expect(res.status).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject(BUSINESS);
    expect(await changeLogsOf(organization.id)).toEqual([]);

    const logged = errorLog.mock.calls.map((call) => String(call[0]));
    expect(logged).toHaveLength(1);
    const line = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      operation: 'organization-plan-update',
      action: 'update',
      organizationId: organization.id,
      error: 'Error',
      changes: { plan: [null, 'business'], billing_interval: [null, 'yearly'], member_limit: [15, 50] },
    });
    expect(logged[0]).not.toContain('secret SQL detail');
  });
});
