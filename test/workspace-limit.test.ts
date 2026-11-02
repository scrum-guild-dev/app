// ワークスペースの個数の上限（#734）。自分用の組織（kind が personal）は、閉じたものも数えて WORKSPACE_LIMITS の個数までしか作れない。
// 上限なら何も書かずに 409 の workspace_limit_reached（details は { used, limit }）。チーム用は制限しない。
// 権限と組織の分離の一覧は test/operation-registry.test.ts が回す
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { WORKSPACE_LIMITS } from '../src/shared/organization-kind.ts';
import { workspaceClose, workspaceCreate, workspaceReopen } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import type { OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPersonalTarget, createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ErrorBody = { error: { code: string; details?: unknown } };

// 作る操作が書く表の、組織の行の数。作る前後で比べて、書かれていないことを確かめる
async function countRows(organization: OrganizationFixture) {
  const db = orgDb(env, organization.verified);
  const organizationId = organization.id;
  const [workspaces, columns, memberships, logs] = await db.batch([
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
  ] as const);
  return {
    workspaces: workspaces.rows.length,
    board_columns: columns.rows.length,
    memberships: memberships.rows.length,
    change_logs: logs.rows.length,
  };
}

let counter = 0;

function create(target: Target) {
  return post(app, workspaceCreate, {
    slug: target.slug,
    token: target.admin.token,
    body: { name: `新規 ${counter++}`, timezone: 'Asia/Tokyo', leader_user_id: target.admin.userId! },
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

function reopen(target: Target, workspaceId: string) {
  return post(app, workspaceReopen, {
    slug: target.slug,
    token: target.admin.token,
    body: { workspace_id: workspaceId },
  });
}

describe('workspace-create の個数の上限', () => {
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

  test('1つ閉じても枠は空かず、開き直しでも個数は増えない', async () => {
    const target = await createPersonalTarget();
    const third = await createdId(await create(target));
    expect(await errorCodeOf(await create(target))).toBe('workspace_limit_reached');

    // 閉じたものも数える
    expect((await close(target, third)).status).toBe(200);
    const closed = await create(target);
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as ErrorBody).error.details).toEqual({ used: 3, limit: 3 });
    expect((await countRows(target.organization)).workspaces).toBe(3);

    // 開き直しは個数を増やさず、確かめも受けない
    expect((await reopen(target, third)).status).toBe(200);
    expect((await countRows(target.organization)).workspaces).toBe(3);
    expect(await errorCodeOf(await create(target))).toBe('workspace_limit_reached');
    expect((await countRows(target.organization)).workspaces).toBe(3);
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
    });
  });

  // 書く前の読みは両方とも2個を見て通るので、上限を守るのは書く文の個数の条件だけ。その条件が閉じたものも数えることを固定する
  test('閉じたものがあっても、上限の1つ手前から2つを同時に作ると、片方だけが通る', async () => {
    const target = await createPersonalTarget();
    expect((await close(target, target.workspace.id)).status).toBe(200);
    expect((await countRows(target.organization)).workspaces).toBe(2);

    const results = await Promise.all([create(target), create(target)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await errorCodeOf(results.find((res) => res.status === 409)!)).toBe('workspace_limit_reached');
    expect((await countRows(target.organization)).workspaces).toBe(3);
  });

  test('チーム用は4個以上作れ、制限されない', async () => {
    const target = await createTarget();
    expect((await countRows(target.organization)).workspaces).toBe(2);
    for (let i = 0; i < 4; i++) await createdId(await create(target));
    expect((await countRows(target.organization)).workspaces).toBe(6);
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
