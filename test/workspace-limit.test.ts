// ワークスペースの個数の上限（#771）。自分用は利用中だけを WORKSPACE_LIMITS の上限まで数える。
// 上限なら何も書かずに 409 の workspace_limit_reached（details は { used, limit }）。チーム用は制限しない。
// 権限と組織の分離の一覧は test/operation-registry.test.ts が回す
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { WORKSPACE_LIMITS } from '../src/shared/organization-kind.ts';
import { workspaceClose, workspaceCreate, workspaceReopen } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createTask, createWorkspace, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPersonalTarget, createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ErrorBody = { error: { code: string; details?: unknown } };

// 作る操作が書く表の、組織の行の数。作る前後で比べて、書かれていないことを確かめる
async function countRows(organization: OrganizationFixture) {
  const db = orgDb(env, organization.verified);
  const organizationId = organization.id;
  const [workspaces, columns, memberships, logs, rates, fields] = await db.batch([
    db.statement((q) => q.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId)),
    db.statement((q) =>
      q
        .selectFrom('board_columns')
        .select('id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
    db.statement((q) =>
      q
        .selectFrom('memberships')
        .select('id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
    db.statement((q) => q.selectFrom('change_logs').select('id').where('organization_id', '=', organizationId)),
    db.statement((q) =>
      q
        .selectFrom('workspace_point_rates')
        .select('workspace_id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
    db.statement((q) =>
      q
        .selectFrom('detail_fields')
        .select('id')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', organizationId),
        ),
    ),
  ] as const);
  return {
    workspaces: workspaces.rows.length,
    board_columns: columns.rows.length,
    memberships: memberships.rows.length,
    change_logs: logs.rows.length,
    workspace_point_rates: rates.rows.length,
    detail_fields: fields.rows.length,
  };
}

let counter = 0;

function create(target: Target, requestEnv?: Env) {
  return post(app, workspaceCreate, {
    slug: target.slug,
    token: target.admin.token,
    body: { name: `新規 ${counter++}`, timezone: 'Asia/Tokyo', leader_user_id: target.admin.userId! },
    env: requestEnv,
  });
}

async function createdId(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { workspace_id: string }).workspace_id;
}

function close(target: Target, workspaceId: string) {
  return post(app, workspaceClose, {
    slug: target.slug,
    token: target.admin.token,
    body: { workspace_id: workspaceId },
  });
}

function reopen(target: Target, workspaceId: string, requestEnv?: Env) {
  return post(app, workspaceReopen, {
    env: requestEnv,
    slug: target.slug,
    token: target.admin.token,
    body: { workspace_id: workspaceId },
  });
}

describe('workspace-create / workspace-reopen の利用中の個数の上限', () => {
  test('上限の定数は、自分用が3、チーム用が無制限', () => {
    expect(WORKSPACE_LIMITS).toEqual({ personal: 3, team: null });
  });

  test('自分用は3個まで作れ、4個目は 409 の workspace_limit_reached で、details に使った数と上限が入り、何も書かれない', async () => {
    // 自分用の目標は、作る前から2個ある（上限の1つ手前から始める）
    const target = await createPersonalTarget();
    expect((await countRows(target.organization)).workspaces).toBe(2);

    await createdId(await create(target));
    expect((await countRows(target.organization)).workspaces).toBe(3);

    const before = await countRows(target.organization);
    const res = await create(target);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('workspace_limit_reached');
    expect(body.error.details).toEqual({ used: 3, limit: 3 });
    // workspaces、列、所属、変更の履歴のどれにも行が増えない
    expect(await countRows(target.organization)).toEqual(before);
  });

  test('終了すると枠が空き、新規作成した後の再開は断られ、別の1つを終了すると再開できる', async () => {
    const target = await createPersonalTarget();
    const third = await createdId(await create(target));
    expect(await errorCodeOf(await create(target))).toBe('workspace_limit_reached');
    expect((await close(target, third)).status).toBe(200);
    const fourth = await createdId(await create(target));
    expect((await countRows(target.organization)).workspaces).toBe(4);
    const before = await countRows(target.organization);
    const refused = await reopen(target, third);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'workspace_limit_reached', details: { used: 3, limit: 3 } },
    });
    expect(await countRows(target.organization)).toEqual(before);
    expect((await close(target, fourth)).status).toBe(200);
    expect((await reopen(target, third)).status).toBe(200);
    expect(await activeCount(target)).toBe(3);
  });

  test('終了済みが多数あっても、空き枠で作成か再開を選べ、上限ではどちらも断る', async () => {
    const target = await createPersonalTarget();
    const closed = [];
    for (let i = 0; i < 5; i++) {
      closed.push(
        await createWorkspace(target.organization, target.admin.userId!, { closed_at: '2026-11-01T00:00:00.000Z' }),
      );
    }
    const third = await createdId(await create(target));
    expect(await errorCodeOf(await reopen(target, closed[0]!.id))).toBe('workspace_limit_reached');
    expect((await close(target, third)).status).toBe(200);
    expect((await reopen(target, closed[0]!.id)).status).toBe(200);
    expect(await errorCodeOf(await create(target))).toBe('workspace_limit_reached');
    expect(await activeCount(target)).toBe(3);
  });

  test('終了・再開しても既存のタスクと履歴は消えず、再開で以前のデータを使える', async () => {
    const target = await createPersonalTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const db = orgDb(env, target.organization.verified);
    const readTasks = () =>
      db.rows(db.statement((q) => q.selectFrom('tasks').selectAll().where('workspace_id', '=', target.workspace.id)));
    const readLogs = () =>
      db.rows(
        db.statement((q) =>
          q
            .selectFrom('change_logs')
            .selectAll()
            .where('organization_id', '=', target.organization.id)
            .where('workspace_id', '=', target.workspace.id),
        ),
      );
    expect((await close(target, target.workspace.id)).status).toBe(200);
    expect(await readTasks()).toContainEqual(task);
    const logs = await readLogs();
    expect((await reopen(target, target.workspace.id)).status).toBe(200);
    expect(await readTasks()).toContainEqual(task);
    expect(await readLogs()).toEqual(expect.arrayContaining(logs));
    expect((await readLogs()).filter((log) => log.action === 'reopen')).toHaveLength(1);
  });

  test('上限のとき、最初のリーダーが候補でなければ、今までどおり 404', async () => {
    const target = await createPersonalTarget();
    await createdId(await create(target));
    const res = await post(app, workspaceCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { name: '新規', timezone: 'Asia/Tokyo', leader_user_id: 'no-such-user' },
    });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('上限の1つ手前から2つを同時に作っても、片方だけが通り、個数は上限を超えない', async () => {
    const target = await createPersonalTarget();
    const before = await countRows(target.organization);
    expect(before.workspaces).toBe(2);

    const results = await Promise.all([create(target), create(target)]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = results.find((res) => res.status === 409)!;
    expect(await errorCodeOf(refused)).toBe('workspace_limit_reached');

    // 通った1つ分だけ書かれている（ワークスペース1、列4、所属1、変更の履歴2）
    const after = await countRows(target.organization);
    expect(after).toEqual({
      workspaces: before.workspaces + 1,
      board_columns: before.board_columns + 4,
      memberships: before.memberships + 1,
      change_logs: before.change_logs + 2,
      workspace_point_rates: before.workspace_point_rates + 1,
      detail_fields: before.detail_fields + 1,
    });
  });

  test('終了済みを数えないので、利用中1個からは同時に2個作れる', async () => {
    const target = await createPersonalTarget();
    expect((await close(target, target.workspace.id)).status).toBe(200);
    const results = await Promise.all([create(target), create(target)]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await activeCount(target)).toBe(3);
  });

  test('チーム用は4個以上作れ、制限されない', async () => {
    const target = await createTarget();
    expect((await countRows(target.organization)).workspaces).toBe(2);
    for (let i = 0; i < 4; i++) await createdId(await create(target));
    expect((await countRows(target.organization)).workspaces).toBe(6);
  });

  test('チーム用は利用中が3個を超えていても再開できる', async () => {
    const target = await createTarget();
    for (let i = 0; i < 3; i++) await createdId(await create(target));
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      closed_at: '2026-11-01T00:00:00.000Z',
    });
    expect((await reopen(target, closed.id)).status).toBe(200);
    expect(await activeCount(target)).toBe(6);
  });

  test('別の個人用が満杯でも自分の再開は通り、別の組織の ID は 404 で何も書かない', async () => {
    const full = await createPersonalTarget();
    await createdId(await create(full));
    const { target, a } = await closedTarget();
    expect((await reopen(target, a.id)).status).toBe(200);
    const before = await countRows(target.organization);
    const otherBefore = await countRows(full.organization);
    const res = await reopen(target, full.workspace.id);
    expect(res.status).toBe(404);
    expect(await countRows(target.organization)).toEqual(before);
    expect(await countRows(full.organization)).toEqual(otherBefore);
  });

  test('ほかの組織の個数は数えない', async () => {
    const full = await createPersonalTarget();
    await createdId(await create(full));
    expect(await errorCodeOf(await create(full))).toBe('workspace_limit_reached');

    const other = await createPersonalTarget();
    await createdId(await create(other));
    expect((await countRows(other.organization)).workspaces).toBe(3);
  });
});

async function activeCount(target: Target) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('id')
        .where('organization_id', '=', target.organization.id)
        .where('closed_at', 'is', null),
    ),
  );
  return rows.length;
}

async function closedTarget() {
  const target = await createPersonalTarget();
  const a = await createWorkspace(target.organization, target.admin.userId!, { closed_at: '2026-11-01T00:00:00.000Z' });
  const b = await createWorkspace(target.organization, target.admin.userId!, { closed_at: '2026-11-01T00:00:00.000Z' });
  return { target, a, b };
}

describe('作成と再開の並行操作', () => {
  test.each(['再開同士', '作成と再開'] as const)(
    '%s も空き枠1つでは片方だけが通り、失敗側に部分書き込みがない',
    async (kind) => {
      const { target, a, b } = await closedTarget();
      const before = await countRows(target.organization);
      const results = await Promise.all([
        reopen(target, a.id),
        kind === '再開同士' ? reopen(target, b.id) : create(target),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await results.find((res) => res.status === 409)!.json()).toMatchObject({
        error: { code: 'workspace_limit_reached', details: { used: 3, limit: 3 } },
      });
      expect(await activeCount(target)).toBe(3);
      const created = kind === '作成と再開' && results[1]!.status === 200;
      expect(await countRows(target.organization)).toEqual({
        workspaces: before.workspaces + (created ? 1 : 0),
        board_columns: before.board_columns + (created ? 4 : 0),
        memberships: before.memberships + (created ? 1 : 0),
        change_logs: before.change_logs + (created ? 2 : 1),
        workspace_point_rates: before.workspace_point_rates + (created ? 1 : 0),
        detail_fields: before.detail_fields + (created ? 1 : 0),
      });
    },
  );

  // 事前の個数検査の直後に別の要求を成功させ、読み取りだけでは守れない競合を確実に作る。
  test.each([
    ['作成', '作成'],
    ['再開', '再開'],
    ['作成', '再開'],
    ['再開', '作成'],
  ] as const)(
    '%s の事前検査の後に別の %s が枠を埋めても、書き込み条件で拒否して何も残さない',
    async (first, second) => {
      const { target, a, b } = await closedTarget();
      let fired = false;
      let afterOther: Awaited<ReturnType<typeof countRows>> | undefined;
      const requestEnv = envWithD1Hooks(testEnv, {
        afterQuery: async (sql) => {
          if (
            !fired &&
            sql.startsWith('select count(*) as "n" from "workspaces"') &&
            sql.includes('"closed_at" is null')
          ) {
            fired = true;
            expect(await activeCount(target)).toBe(2);
            const res = second === '作成' ? await create(target) : await reopen(target, b.id);
            expect(res.status).toBe(200);
            afterOther = await countRows(target.organization);
          }
        },
      });
      const res = first === '作成' ? await create(target, requestEnv) : await reopen(target, a.id, requestEnv);
      expect(fired).toBe(true);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: 'workspace_limit_reached', details: { used: 3, limit: 3 } },
      });
      expect(await activeCount(target)).toBe(3);
      expect(await countRows(target.organization)).toEqual(afterOther);
    },
  );
});
