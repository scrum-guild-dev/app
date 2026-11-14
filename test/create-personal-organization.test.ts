// 自分用の組織を作る操作（create-personal-organization, #733）。組織に入らない会員が、slug だけで1人だけの組織を作り、その管理者になる。
// 自分用は1アカウントに1つ（部分 UNIQUE 索引）。お試し中の組織の上限（trial_limit）とは数えが別
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  createMyOrganization,
  createPersonalOrganization,
  createPersonalOrganizationConflictReasonOf,
  createPersonalOrganizationConflictReasons,
  myOrganizations,
  organizationInfo,
  organizationOperations,
} from '../src/shared/operations/organization/index.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { taskCreate } from '../src/shared/operations/task/index.ts';
import { consentRecord } from '../src/shared/operations/session/consent.ts';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { createAccount, createAccountLogin, createOrganization, createSessionWithToken } from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createLoginPerson, createPerson, testEnv } from './operations/world.ts';

const app = createApp(implementedOperations);

const GIGABYTE = 1073741824;

let counter = 0;
const newSlug = () => `solo-${crypto.randomUUID().slice(0, 8)}-${counter++}`;

// どの組織にも属さない会員（users の行を持たない）
async function newMember(loginName = 'mio-hoshino') {
  const account = await createAccount();
  await createAccountLogin(account.id, { login_name: loginName });
  const { token } = await createSessionWithToken(account.id);
  return { accountId: account.id, token };
}
type Member = Awaited<ReturnType<typeof newMember>>;

const create = (member: Pick<Member, 'token'>, slug: string) =>
  post(app, createPersonalOrganization, { token: member.token, body: { slug } });

async function organizationRow(slug: string): Promise<Record<string, unknown> | null> {
  const db = commonDb(env);
  return (
    (await db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('slug', '=', slug)))) ?? null
  );
}

async function organizationsOf(accountId: string): Promise<Record<string, unknown>[]> {
  const db = commonDb(env);
  return db.rows(
    db.statement((q) => q.selectFrom('organizations').selectAll().where('created_by_account_id', '=', accountId)),
  );
}

async function organizationCount(): Promise<number> {
  const db = commonDb(env);
  const rows = await db.rows(db.statement((q) => q.selectFrom('organizations').select('id')));
  return rows.length;
}

const orgDbOf = (organizationId: string) => orgDb(env, verifiedOrganizationForTest(organizationId));

async function usersOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(db.statement((q) => q.selectFrom('users').selectAll().where('organization_id', '=', organizationId)));
}

async function changeLogsOf(organizationId: string) {
  const db = orgDbOf(organizationId);
  return db.rows(
    db.statement((q) => q.selectFrom('change_logs').selectAll().where('organization_id', '=', organizationId)),
  );
}

type ErrorBody = { error: { code: string; details?: unknown } };
const detailsOf = async (res: Response) => ((await res.json()) as ErrorBody).error.details;

async function expectConflict(res: Response, reason: (typeof createPersonalOrganizationConflictReasons)[number]) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe('conflict');
  expect(body.error.details).toEqual({ reason });
}

describe('定義', () => {
  test('ログインしていれば呼べる書き込みで、Cookie からだけ、アカウントと操作ごとに10分に30回まで', () => {
    expect(createPersonalOrganization).toMatchObject({
      name: 'create-personal-organization',
      mode: 'write',
      permission: 'login',
      cookieOnly: true,
      rateLimit: { max: 30, windowSeconds: 600 },
    });
    expect(createPersonalOrganization).not.toHaveProperty('skipsConsent');
  });

  test('入力は slug だけで、出力は slug と name', () => {
    expect(createPersonalOrganization.input.safeParse({ slug: 'solo' }).success).toBe(true);
    // 名前は固定なので受け取らない（余計な項目は読み捨てられ、名前にはならない）
    expect(createPersonalOrganization.input.parse({ slug: 'solo', name: '別名' })).toEqual({ slug: 'solo' });
    expect(createPersonalOrganization.output.safeParse({ slug: 'solo', name: '自分用' }).success).toBe(true);
  });

  test('断る理由は slug_taken と personal_limit', () => {
    expect(createPersonalOrganizationConflictReasons).toEqual(['slug_taken', 'personal_limit']);
    expect(createPersonalOrganizationConflictReasonOf({ reason: 'personal_limit' })).toBe('personal_limit');
    expect(createPersonalOrganizationConflictReasonOf({ reason: 'trial_limit' })).toBeUndefined();
  });

  test('組織の操作の一覧に入っていて、create-my-organization に kind は足さない', () => {
    expect(organizationOperations).toContain(createPersonalOrganization);
    expect(createMyOrganization.input.shape).not.toHaveProperty('kind');
    expect(createPersonalOrganization.input.shape).not.toHaveProperty('kind');
  });

  test('本番の一覧に実装がある', () => {
    expect(implementedOperations.map((operation) => operation.definition.name)).toContain(
      'create-personal-organization',
    );
  });
});

describe('組織に入っていない会員が作る', () => {
  test('slug と固定の名前「自分用」を返し、行は personal、1人、1GB、お試しの期限なし、self-service、作った人', async () => {
    const member = await newMember();
    const slug = newSlug();
    const writes: string[] = [];
    const res = await post(app, createPersonalOrganization, {
      token: member.token,
      body: { slug },
      env: envWithD1Hooks(testEnv, { beforeBatch: (sqls) => void writes.push(...sqls) }),
    });
    const inserts = writes.filter((sql) => sql.startsWith('insert into "organizations"'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toMatch(/vocabulary/i);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug, name: '自分用' });

    const row = await organizationRow(slug);
    expect(row).toMatchObject({
      name: '自分用',
      kind: 'personal',
      member_limit: 1,
      attachment_quota_bytes: GIGABYTE,
      trial_ends_on: null,
      created_by_operator: 'self-service',
      created_by_account_id: member.accountId,
      suspended_at: null,
      purge_on: null,
    });
  });

  test('作った人が管理者の users の行になり、名前はアカウントのログイン名', async () => {
    const member = await newMember('hoshino-mio');
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const organization = (await organizationRow(slug))!;

    const users = await usersOf(organization.id as string);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      account_id: member.accountId,
      name: 'hoshino-mio',
      is_admin: 1,
      disabled_at: null,
    });
  });

  test('change_logs に組織の作成が残り、changes_json に kind も入る', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const organization = (await organizationRow(slug))!;
    const [user] = await usersOf(organization.id as string);

    const created = (await changeLogsOf(organization.id as string)).filter((log) => log.entity_type === 'organization');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      organization_id: organization.id,
      entity_id: organization.id,
      action: 'create',
      actor_user_id: user!.id,
      operator: null,
    });
    const changes = JSON.parse(created[0]!.changes_json!) as Record<string, unknown>;
    expect(changes).toMatchObject({ slug: [null, slug], name: [null, '自分用'], kind: [null, 'personal'] });
  });

  test('作った組織に slug で入れ、管理者としてワークスペースを作ってタスクを作れる', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);

    const info = await post(app, organizationInfo, { slug, token: member.token });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ organization: { name: '自分用' }, me: { is_admin: true } });

    const [user] = await usersOf((await organizationRow(slug))!.id as string);
    const workspace = await post(app, workspaceCreate, {
      slug,
      token: member.token,
      body: { name: '自分の仕事', timezone: 'Asia/Tokyo', leader_user_id: user!.id },
    });
    expect(workspace.status).toBe(200);
    const { workspace_id } = (await workspace.json()) as { workspace_id: string };

    const task = await post(app, taskCreate, {
      slug,
      token: member.token,
      body: { workspace_id, title: '見積もりを送る', points: 3 },
    });
    expect(task.status).toBe(200);
    expect(await task.json()).toMatchObject({ task: { title: '見積もりを送る', points: 3 } });
  });

  test('作った後の入れる組織の一覧に、kind が personal で載る', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const res = await post(app, myOrganizations, { token: member.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: unknown[] };
    expect(body.organizations).toEqual([{ slug, name: '自分用', kind: 'personal' }]);
  });

  test('チーム用の組織の管理者でもある人も作れ、一覧には両方が kind つきで並ぶ', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    const slug = newSlug();
    expect((await create(person, slug)).status).toBe(200);
    const res = await post(app, myOrganizations, { token: person.token });
    const body = (await res.json()) as { organizations: { slug: string; kind: string }[] };
    expect(body.organizations).toHaveLength(2);
    expect(body.organizations.find((item) => item.slug === slug)?.kind).toBe('personal');
    expect(body.organizations.find((item) => item.slug === organization.slug)?.kind).toBe('team');
  });

  test('チーム用の組織の slug を使っても、運用者が作った組織の管理者であることは自分用の上限に数えない', async () => {
    const organization = await createOrganization({ created_by_account_id: null });
    const person = await createPerson({ organization, admin: true });
    expect((await create(person, newSlug())).status).toBe(200);
    expect(await organizationsOf(person.accountId)).toHaveLength(1);
  });
});

describe('2つ目は作れない', () => {
  test('同じアカウントの2つ目は 409 の conflict（personal_limit）で、組織の行が増えない', async () => {
    const member = await newMember();
    const first = newSlug();
    expect((await create(member, first)).status).toBe(200);
    const count = await organizationCount();

    const second = newSlug();
    await expectConflict(await create(member, second), 'personal_limit');
    expect(await organizationCount()).toBe(count);
    expect(await organizationRow(second)).toBeNull();
    expect((await organizationsOf(member.accountId)).map((row) => row.slug)).toEqual([first]);
  });

  test('別のアカウントは、自分の1つ目を作れる', async () => {
    const first = await newMember();
    const second = await newMember();
    expect((await create(first, newSlug())).status).toBe(200);
    expect((await create(second, newSlug())).status).toBe(200);
  });

  test('運用者が作った組織の管理者であっても、自分用は1つ作れる', async () => {
    const person = await createLoginPerson();
    expect((await create(person, newSlug())).status).toBe(200);
  });
});

describe('slug が重なる', () => {
  test('チーム用の組織の slug は 409 の conflict（slug_taken）で、組織も自分用の枠も増えない', async () => {
    const existing = await createOrganization();
    const member = await newMember();
    const count = await organizationCount();
    await expectConflict(await create(member, existing.slug), 'slug_taken');
    expect(await organizationCount()).toBe(count);
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
    // 断られた後に別の slug で作れる（枠を使っていない）
    expect((await create(member, newSlug())).status).toBe(200);
  });

  test('別の人の自分用の slug も 409（slug_taken）', async () => {
    const first = await newMember();
    const slug = newSlug();
    expect((await create(first, slug)).status).toBe(200);
    const second = await newMember();
    await expectConflict(await create(second, slug), 'slug_taken');
    expect(await organizationsOf(second.accountId)).toHaveLength(0);
  });

  test('自分の自分用と同じ slug をもう一度送ると 409 で、行は増えない', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const count = await organizationCount();
    const res = await create(member, slug);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(createPersonalOrganizationConflictReasons).toContain((body.error.details as { reason: string }).reason);
    expect(await organizationCount()).toBe(count);
  });

  test('チーム用の組織を作る道（create-my-organization）で取った slug も 409（slug_taken）', async () => {
    const owner = await newMember();
    const slug = newSlug();
    const made = await post(app, createMyOrganization, { token: owner.token, body: { slug, name: '青葉工房' } });
    expect(made.status).toBe(200);
    const member = await newMember();
    await expectConflict(await create(member, slug), 'slug_taken');
  });
});

describe('お試し中の組織の上限とは数えが別', () => {
  test('自分用を持っていても、お試しの組織を作れる', async () => {
    const member = await newMember();
    expect((await create(member, newSlug())).status).toBe(200);
    const team = newSlug();
    const res = await post(app, createMyOrganization, { token: member.token, body: { slug: team, name: '青葉工房' } });
    expect(res.status).toBe(200);
    expect(await organizationsOf(member.accountId)).toHaveLength(2);
    expect((await organizationRow(team))?.kind).toBe('team');
  });

  test('お試しの組織を持っていても、自分用を作れる', async () => {
    const member = await newMember();
    const res = await post(app, createMyOrganization, {
      token: member.token,
      body: { slug: newSlug(), name: '青葉工房' },
    });
    expect(res.status).toBe(200);
    expect((await create(member, newSlug())).status).toBe(200);
  });

  test('お試しの上限（trial_limit）には、自分用は数えられない', async () => {
    const member = await newMember();
    expect((await create(member, newSlug())).status).toBe(200);
    expect(
      (await post(app, createMyOrganization, { token: member.token, body: { slug: newSlug(), name: 'A 工房' } }))
        .status,
    ).toBe(200);
    // お試しの2つ目は、今まで通り trial_limit
    const third = await post(app, createMyOrganization, {
      token: member.token,
      body: { slug: newSlug(), name: 'B 工房' },
    });
    expect(third.status).toBe(409);
    expect(await detailsOf(third)).toEqual({ reason: 'trial_limit' });
  });

  test('お試しの組織が上限（trial_limit）に当たっている人も、自分用は作れる', async () => {
    const member = await newMember();
    await createOrganization({ created_by_account_id: member.accountId, trial_ends_on: '2099-01-01' });
    expect((await create(member, newSlug())).status).toBe(200);
  });
});

describe('入力を断る（create-my-organization と同じ規則）', () => {
  test.each(['A-b', 'a', '-ab', 'ab_c', 'あおば', 'a'.repeat(41), 'ab cd', 'AOBA'])(
    '形の合わない slug %s は 400 の invalid_input（slug_format）で、組織を作らない',
    async (slug) => {
      const member = await newMember();
      const count = await organizationCount();
      const res = await create(member, slug);
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res.clone())).toBe('invalid_input');
      expect(await detailsOf(res)).toEqual([expect.objectContaining({ path: 'slug', code: 'slug_format' })]);
      expect(await organizationCount()).toBe(count);
      expect(await organizationsOf(member.accountId)).toHaveLength(0);
    },
  );

  test.each([' aoba', 'aoba ', ' aoba ', '\taoba', 'aoba\n'])(
    '前後に空白のある slug %j は 400 の invalid_input で、組織を作らない（削って通さない）',
    async (slug) => {
      const member = await newMember();
      const count = await organizationCount();
      const res = await create(member, slug);
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
      expect(await organizationCount()).toBe(count);
      expect(await organizationRow(slug.trim())).toBeNull();
    },
  );

  test.each(['api', 'login', 'operator', 'consent', 'signup', 'cdn-cgi', 'invite'])(
    '予約した名前 %s は 400 の invalid_input（slug_reserved）で、組織を作らない',
    async (slug) => {
      const member = await newMember();
      const count = await organizationCount();
      const res = await create(member, slug);
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res.clone())).toBe('invalid_input');
      expect(await detailsOf(res)).toEqual([expect.objectContaining({ path: 'slug', code: 'slug_reserved' })]);
      expect(await organizationCount()).toBe(count);
    },
  );

  test.each(['API', 'Login', 'OPERATOR'])(
    '予約した名前の大文字 %s は 400（形の違反）で、組織を作らない',
    async (slug) => {
      const member = await newMember();
      const res = await create(member, slug);
      expect(res.status).toBe(400);
      expect(await organizationsOf(member.accountId)).toHaveLength(0);
    },
  );

  test('既にある slug の大文字小文字を変えても、409 ではなく 400 で断り、既存の組織は変わらない', async () => {
    const existing = await createOrganization();
    const member = await newMember();
    const res = await create(member, existing.slug.toUpperCase());
    expect(res.status).toBe(400);
    expect(await detailsOf(res)).toEqual([expect.objectContaining({ path: 'slug', code: 'slug_format' })]);
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
  });

  test.each([
    ['2 字（下限）', () => `x${Math.floor(Math.random() * 10)}`],
    ['40 字（上限）', () => `a${crypto.randomUUID().replaceAll('-', '')}`.slice(0, 40).padEnd(40, 'b')],
    ['数字で始まる', () => `0${crypto.randomUUID().slice(0, 8)}`],
    ['ハイフンを含む', () => `a-${crypto.randomUUID().slice(0, 8)}-c`],
  ])('slug が%sなら作れる', async (_label, makeSlug) => {
    const slug = makeSlug();
    const member = await newMember();
    // 2 字は他のテストと重なりうるので、重なったときは slug_taken（形の違反ではない）であればよい
    const res = await create(member, slug);
    if (slug.length === 2 && res.status === 409) {
      expect(await detailsOf(res)).toEqual({ reason: 'slug_taken' });
      return;
    }
    expect(res.status).toBe(200);
    expect(((await res.json()) as { slug: string }).slug).toBe(slug);
  });

  test('slug が 80 字を超えると入力の形で 400（invalid_input）', async () => {
    const member = await newMember();
    const res = await create(member, 'a'.repeat(81));
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
  });

  test('slug が無い、文字列でない入力は 400（invalid_input）', async () => {
    const member = await newMember();
    for (const body of [{}, { slug: null }, { slug: 12 }, { slug: ['solo'] }]) {
      const res = await post(app, createPersonalOrganization, { token: member.token, body });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
  });

  test('名前を送っても使わず、名前は「自分用」のまま', async () => {
    const member = await newMember();
    const slug = newSlug();
    const res = await post(app, createPersonalOrganization, { token: member.token, body: { slug, name: '乗っ取り' } });
    // 余計な項目を断っても、読み捨てて通してもよいが、名前が変わってはならない
    if (res.status === 200) expect(await res.json()).toEqual({ slug, name: '自分用' });
    const row = await organizationRow(slug);
    if (row !== null) expect(row.name).toBe('自分用');
  });
});

describe('同時に送る', () => {
  test.each([2, 5])('同じアカウントが別の slug を %s つ同時に送っても、自分用は1つだけ', async (n) => {
    const member = await newMember();
    const slugs = Array.from({ length: n }, () => newSlug());
    const responses = await Promise.all(slugs.map((slug) => create(member, slug)));
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, ...Array.from({ length: n - 1 }, () => 409)]);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect(((await res.json()) as ErrorBody).error.details).toEqual({ reason: 'personal_limit' });
    }
    const created = await organizationsOf(member.accountId);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('personal');
    // 通った1つだけが、管理者の users と作成の change_logs を持つ
    expect(await usersOf(created[0]!.id as string)).toHaveLength(1);
    expect((await changeLogsOf(created[0]!.id as string)).filter((log) => log.action === 'create')).toHaveLength(1);
    for (const slug of slugs) {
      if (slug !== created[0]!.slug) expect(await organizationRow(slug)).toBeNull();
    }
  });

  test('別のアカウントが同じ slug を同時に送ると、片方だけ成功し、もう片方は 409（slug_taken）', async () => {
    const a = await newMember();
    const b = await newMember();
    const slug = newSlug();
    const [resA, resB] = await Promise.all([create(a, slug), create(b, slug)]);
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const loser = resA.status === 409 ? resA : resB;
    expect(((await loser.json()) as ErrorBody).error.details).toEqual({ reason: 'slug_taken' });

    const row = (await organizationRow(slug))!;
    expect([a.accountId, b.accountId]).toContain(row.created_by_account_id);
    expect(await usersOf(row.id as string)).toHaveLength(1);
    const loserAccount = row.created_by_account_id === a.accountId ? b.accountId : a.accountId;
    expect(await organizationsOf(loserAccount)).toHaveLength(0);
  });

  test('自分用とお試しの組織を同時に送ると、どちらも作れる', async () => {
    const member = await newMember();
    const [personal, team] = await Promise.all([
      create(member, newSlug()),
      post(app, createMyOrganization, { token: member.token, body: { slug: newSlug(), name: '青葉工房' } }),
    ]);
    expect(personal.status).toBe(200);
    expect(team.status).toBe(200);
    const rows = await organizationsOf(member.accountId);
    expect(rows.map((row) => row.kind).sort()).toEqual(['personal', 'team']);
  });
});

describe('他の組織の人からは見えない', () => {
  test('別の組織の会員が自分用の slug で入ろうとすると、存在しない slug と同じ 404', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const outsider = await createLoginPerson();

    const res = await post(app, organizationInfo, { slug, token: outsider.token });
    const missing = await post(app, organizationInfo, { slug: newSlug(), token: outsider.token });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res.clone())).toBe('not_found');
    expect(res.status).toBe(missing.status);
    expect(await res.json()).toEqual(await missing.json());
  });

  test('別の自分用の持ち主も、互いの組織には入れず 404', async () => {
    const a = await newMember();
    const b = await newMember();
    const slugA = newSlug();
    expect((await create(a, slugA)).status).toBe(200);
    expect((await create(b, newSlug())).status).toBe(200);
    const res = await post(app, organizationInfo, { slug: slugA, token: b.token });
    expect(res.status).toBe(404);
  });

  test('他の人の入れる組織の一覧に載らない', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const outsider = await createLoginPerson();
    const res = await post(app, myOrganizations, { token: outsider.token });
    const body = (await res.json()) as { organizations: { slug: string }[]; suspended: { slug: string }[] };
    expect(body.organizations.map((item) => item.slug)).not.toContain(slug);
    expect(body.suspended.map((item) => item.slug)).not.toContain(slug);
  });

  test('自分用の中のワークスペースへ、別の組織の人は書けず 404', async () => {
    const member = await newMember();
    const slug = newSlug();
    expect((await create(member, slug)).status).toBe(200);
    const [user] = await usersOf((await organizationRow(slug))!.id as string);
    const outsider = await createLoginPerson();
    const res = await post(app, workspaceCreate, {
      slug,
      token: outsider.token,
      body: { name: '勝手な場所', timezone: 'Asia/Tokyo', leader_user_id: user!.id },
    });
    expect(res.status).toBe(404);
  });
});

describe('権限', () => {
  test('同意していない人は 403 の terms_required で、組織を作らない', async () => {
    const person = await createPerson({ consented: false });
    const res = await create(person, newSlug());
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('terms_required');
    expect(await organizationsOf(person.accountId)).toHaveLength(0);
  });

  test('同意した後は同じ人が作れる', async () => {
    const person = await createPerson({ consented: false });
    const consent = await post(app, consentRecord, {
      token: person.token,
      body: { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION },
    });
    expect(consent.status).toBe(200);
    expect((await create(person, newSlug())).status).toBe(200);
  });

  test('ログインしていないと 401 の unauthenticated', async () => {
    const count = await organizationCount();
    const res = await post(app, createPersonalOrganization, { body: { slug: newSlug() } });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe('unauthenticated');
    expect(await organizationCount()).toBe(count);
  });

  test('Origin が違う Cookie の呼び出しは 403 で、組織を作らない', async () => {
    const member = await newMember();
    const res = await post(app, createPersonalOrganization, {
      token: member.token,
      origin: 'https://evil.example',
      body: { slug: newSlug() },
    });
    expect(res.status).toBe(403);
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
  });

  test.each(['write', 'read'] as const)('%s の API トークンは 403 で、組織を作らない（cookieOnly）', async (scope) => {
    const member = await newMember();
    const slug = newSlug();
    const res = await post(app, createPersonalOrganization, {
      bearer: await bearerFor(member, scope),
      body: { slug },
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect(await organizationRow(slug)).toBeNull();
    expect(await organizationsOf(member.accountId)).toHaveLength(0);
  });

  test('API トークンで断られても、自分用の枠は残り、画面からは作れる', async () => {
    const member = await newMember();
    const denied = await post(app, createPersonalOrganization, {
      bearer: await bearerFor(member, 'write'),
      body: { slug: newSlug() },
    });
    expect(denied.status).toBe(403);
    expect((await create(member, newSlug())).status).toBe(200);
  });
});

describe('回数の上限', () => {
  test('アカウントと操作ごとに10分に30回まで。31回目は 429 の rate_limited で、組織を作らない', async () => {
    const member = await newMember();
    // 入力の誤り（形の違反）で断られる呼び出しも1回に数える
    for (let i = 0; i < 30; i++) {
      expect((await create(member, 'A')).status).toBe(400);
    }
    const slug = newSlug();
    const res = await create(member, slug);
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
    expect(await organizationRow(slug)).toBeNull();
  });

  test('create-my-organization の回数とは別の枠で数える', async () => {
    const member = await newMember();
    for (let i = 0; i < 30; i++) {
      expect(
        (await post(app, createMyOrganization, { token: member.token, body: { slug: 'A', name: '青葉工房' } })).status,
      ).toBe(400);
    }
    expect((await create(member, newSlug())).status).toBe(200);
  });
});
