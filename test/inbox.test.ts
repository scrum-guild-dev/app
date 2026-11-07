// 受信箱の一覧（inbox-list）と、バックログへ入れる操作（inbox-to-backlog）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { inboxList, inboxToBacklog } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createConnection, createRepository, createTask, createTaskSource, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function list(target: Target, workspaceId: string = target.workspace.id) {
  return post(app, inboxList, { slug: target.slug, token: target.member.token, body: { workspace_id: workspaceId } });
}

function move(target: Target, items: unknown[], workspaceId: string = target.workspace.id, requestEnv: Env = testEnv) {
  return post(app, inboxToBacklog, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: workspaceId, items },
    env: requestEnv,
  });
}

async function connect(target: Target, overrides: Parameters<typeof createConnection>[3] = {}) {
  return createConnection(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

// 取り込み元に結んだ受信箱のタスク
async function arrive(
  target: Target,
  connectionId: string,
  at: string,
  overrides: Parameters<typeof createTask>[3] = {},
  sourceKey = 'aoba/shop#1',
) {
  const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
    tray: 'inbox',
    is_imported: 1,
    created_at: at,
    updated_at: at,
    ...overrides,
  });
  await createTaskSource(target.organization, target.workspace.id, task.id, connectionId, {
    source_key: sourceKey,
    source_id: `node-${sourceKey}`,
  });
  return task;
}

async function rowOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(db.statement((q) => q.selectFrom('tasks').selectAll().where('id', '=', taskId)));
}

async function logsOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', taskId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

async function reasonOf(res: Response): Promise<unknown> {
  const body = (await res.json()) as { error?: { details?: { reason?: unknown } } };
  return body.error?.details?.reason;
}

type ListBody = {
  tasks: { id: string; source_key: string; connection_name: string; arrived_at: string; repository: unknown }[];
  total: number;
  connection_count: number;
  last_success_at: string | null;
};

describe('inbox-list', () => {
  test('接続が無いと、空の一覧と接続の数 0 を返す', async () => {
    const target = await createTarget();
    const body = (await (await list(target)).json()) as ListBody;
    expect(body).toMatchObject({ tasks: [], total: 0, connection_count: 0, last_success_at: null });
  });

  test('受信箱のタスクだけを、届いた日時の新しい順に返し、最後に成功した日時を添える', async () => {
    const target = await createTarget();
    const a = await connect(target, { name: 'ミナトの GitHub', last_success_at: '2026-10-20T01:00:00.000Z' });
    const b = await connect(target, { name: 'ハルカの GitHub', last_success_at: '2026-10-20T03:00:00.000Z' });
    await connect(target, { deleted_at: '2026-10-20T00:00:00.000Z', last_success_at: '2026-10-21T00:00:00.000Z' });
    const older = await arrive(target, a.id, '2026-10-19T00:00:00.000Z', {}, 'aoba/shop#1');
    const newer = await arrive(target, b.id, '2026-10-20T00:00:00.000Z', {}, 'aoba/shop#2');
    await arrive(target, a.id, '2026-10-20T00:00:00.000Z', { deleted_at: '2026-10-20T01:00:00.000Z' }, 'aoba/shop#3');
    await arrive(target, a.id, '2026-10-20T00:00:00.000Z', { tray: 'backlog' }, 'aoba/shop#4');
    await arrive(target, a.id, '2026-10-20T00:00:00.000Z', { tray: 'archive' }, 'aoba/shop#5');
    const body = (await (await list(target)).json()) as ListBody;
    expect(body.tasks.map((task) => task.id)).toEqual([newer.id, older.id]);
    expect(body.tasks[0]).toMatchObject({
      source_key: 'aoba/shop#2',
      connection_name: 'ハルカの GitHub',
      arrived_at: '2026-10-20T00:00:00.000Z',
      repository: null,
    });
    expect(body).toMatchObject({ total: 2, connection_count: 2, last_success_at: '2026-10-20T03:00:00.000Z' });
  });

  test('ほかのワークスペースの受信箱と接続は混ざらない', async () => {
    const target = await createTarget();
    const other = await createWorkspace(target.organization, target.admin.userId!);
    const mine = await connect(target);
    const theirs = await createConnection(target.organization, other.id, target.admin.userId!);
    await arrive(target, mine.id, '2026-10-20T00:00:00.000Z');
    const foreign = await createTask(target.organization, other.id, target.admin.userId!, {
      tray: 'inbox',
      is_imported: 1,
    });
    await createTaskSource(target.organization, other.id, foreign.id, theirs.id);
    const body = (await (await list(target)).json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.connection_count).toBe(1);
  });
});

describe('inbox-to-backlog', () => {
  test('選んだタスクをバックログの親のない末尾へ、届いた順のまま移し、履歴を残す', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    await createTask(target.organization, target.workspace.id, target.admin.userId!, { position: 'a5' });
    const first = await arrive(target, connection.id, '2026-10-19T00:00:00.000Z', {}, 'aoba/shop#1');
    const second = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z', {}, 'aoba/shop#2');
    const left = await arrive(target, connection.id, '2026-10-20T01:00:00.000Z', {}, 'aoba/shop#3');
    const res = await move(target, [{ task_id: second.id }, { task_id: first.id }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: 2 });
    const a = (await rowOf(target, first.id))!;
    const b = (await rowOf(target, second.id))!;
    expect(a).toMatchObject({ tray: 'backlog', story_id: null, sprint_id: null });
    expect(b.tray).toBe('backlog');
    expect(a.position > 'a5').toBe(true);
    expect(b.position > a.position).toBe(true);
    expect((await rowOf(target, left.id))!.tray).toBe('inbox');
    const logs = await logsOf(target, first.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.member.userId });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ tray: ['inbox', 'backlog'] });
    const after = (await (await list(target)).json()) as ListBody;
    expect(after.tasks.map((task) => task.id)).toEqual([left.id]);
  });

  test('リポジトリを選んだ行は、移す前に振り、履歴に前と後を残す', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const repository = await createRepository(target.organization, target.workspace.id, { name: 'shop' });
    const task = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z');
    const res = await move(target, [{ task_id: task.id, repository_id: repository.id }]);
    expect(res.status).toBe(200);
    expect((await rowOf(target, task.id))!).toMatchObject({ tray: 'backlog', repository_id: repository.id });
    const logs = (await logsOf(target, task.id)).map((log) => JSON.parse(log.changes_json));
    expect(logs).toContainEqual({ repository: [null, { id: repository.id, name: 'shop' }] });
    expect(logs).toContainEqual({ tray: ['inbox', 'backlog'] });
  });

  test('削除したリポジトリと別のワークスペースのリポジトリは 404 で、何も移さない', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const other = await createWorkspace(target.organization, target.admin.userId!);
    const deleted = await createRepository(target.organization, target.workspace.id, {
      deleted_at: '2026-10-20T00:00:00.000Z',
    });
    const foreign = await createRepository(target.organization, other.id);
    const task = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z');
    for (const repository of [deleted, foreign]) {
      const res = await move(target, [{ task_id: task.id, repository_id: repository.id }]);
      expect(res.status).toBe(404);
    }
    expect((await rowOf(target, task.id))!.tray).toBe('inbox');
  });

  test('受信箱に無いタスクが混じると、何も移さず 409 の not_in_inbox', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const inbox = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z', {}, 'aoba/shop#1');
    const moved = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z', { tray: 'backlog' }, 'aoba/shop#2');
    const res = await move(target, [{ task_id: inbox.id }, { task_id: moved.id }]);
    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('not_in_inbox');
    expect((await rowOf(target, inbox.id))!.tray).toBe('inbox');
    expect(await logsOf(target, inbox.id)).toHaveLength(0);
  });

  test('同じタスクの2回目は 409 で、位置も履歴も増えない', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const task = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z');
    expect((await move(target, [{ task_id: task.id }])).status).toBe(200);
    const before = (await rowOf(target, task.id))!;
    const res = await move(target, [{ task_id: task.id }]);
    expect(res.status).toBe(409);
    expect((await rowOf(target, task.id))!.position).toBe(before.position);
    expect(await logsOf(target, task.id)).toHaveLength(1);
  });

  test('別のワークスペース、存在しない、削除済みの ID が混じると 404 で、何も移さない', async () => {
    const target = await createTarget();
    const other = await createWorkspace(target.organization, target.admin.userId!);
    const connection = await connect(target);
    const mine = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z', {}, 'aoba/shop#1');
    const gone = await arrive(
      target,
      connection.id,
      '2026-10-20T00:00:00.000Z',
      { deleted_at: '2026-10-20T01:00:00.000Z' },
      'aoba/shop#2',
    );
    const foreign = await createTask(target.organization, other.id, target.admin.userId!, {
      tray: 'inbox',
      is_imported: 1,
    });
    for (const id of [foreign.id, gone.id, 'no-such-task']) {
      const res = await move(target, [{ task_id: mine.id }, { task_id: id }]);
      expect(res.status).toBe(404);
    }
    expect((await rowOf(target, mine.id))!.tray).toBe('inbox');
  });

  test('別の組織のタスクと別の組織のリポジトリの ID を、自分のワークスペースに混ぜると 404 で、何も移さない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const connection = await connect(target);
    const mine = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z', {}, 'aoba/shop#1');
    const theirsConnection = await createConnection(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const theirs = await arrive(foreign, theirsConnection.id, '2026-10-20T00:00:00.000Z', {}, 'aoba/shop#1');
    const theirRepository = await createRepository(foreign.organization, foreign.workspace.id);
    expect((await move(target, [{ task_id: mine.id }, { task_id: theirs.id }])).status).toBe(404);
    expect((await move(target, [{ task_id: mine.id, repository_id: theirRepository.id }])).status).toBe(404);
    expect((await rowOf(target, mine.id))!.tray).toBe('inbox');
    expect((await rowOf(foreign, theirs.id))!.tray).toBe('inbox');
  });

  test('リポジトリを読んだ後に別の要求が変えたら、何も移さず 409 で、選んだリポジトリを黙って落とさない', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const chosen = await createRepository(target.organization, target.workspace.id, { name: 'shop' });
    const other = await createRepository(target.organization, target.workspace.id, { name: 'admin' });
    const task = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z');
    let done = false;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (done || !/from "repositories"/i.test(sql)) return;
        done = true;
        const db = orgDb(env, target.organization.verified);
        await db.run(
          db.statement((q) => q.updateTable('tasks').set({ repository_id: other.id }).where('id', '=', task.id)),
        );
      },
    });
    const res = await move(target, [{ task_id: task.id, repository_id: chosen.id }], target.workspace.id, racing);
    expect(res.status).toBe(409);
    expect((await rowOf(target, task.id))!.tray).toBe('inbox');
  });

  test('リポジトリ付きで100件をまとめて移せる', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const repository = await createRepository(target.organization, target.workspace.id);
    const tasks = [];
    for (let index = 0; index < 100; index++) {
      tasks.push(
        await arrive(
          target,
          connection.id,
          `2026-10-20T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
          {},
          `aoba/shop#${index + 1}`,
        ),
      );
    }
    const res = await move(
      target,
      tasks.map((task) => ({ task_id: task.id, repository_id: repository.id })),
    );
    expect(res.status).toBe(200);
    expect((await rowOf(target, tasks[99]!.id))!).toMatchObject({ tray: 'backlog', repository_id: repository.id });
  }, 60_000);

  test('一覧は届いた日時の新しい順に200件までで、担当とリポジトリと選べるリポジトリを返す', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const repository = await createRepository(target.organization, target.workspace.id, { name: 'shop' });
    const assigned = await arrive(target, connection.id, '2026-10-21T00:00:00.000Z', {
      assignee_user_id: target.member.userId,
      repository_id: repository.id,
    });
    const db = orgDb(env, target.organization.verified);
    for (let index = 0; index < 200; index++) {
      const id = `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
      await db.batch([
        db.statement((q) =>
          q.insertInto('tasks').values({
            id,
            workspace_id: target.workspace.id,
            is_imported: 1,
            tray: 'inbox',
            title: `たくさん-${index}`,
            position: 'a0',
            created_at: '2026-10-19T00:00:00.000Z',
            updated_at: '2026-10-19T00:00:00.000Z',
          }),
        ),
        db.statement((q) =>
          q.insertInto('task_sources').values({
            task_id: id,
            workspace_id: target.workspace.id,
            connection_id: connection.id,
            provider: 'github',
            source_kind: 'issue',
            source_id: id,
            reviewer_source_id: '',
            source_key: `aoba/many#${index}`,
            source_url: `https://github.com/aoba/many/issues/${index}`,
            source_container_id: '1',
            source_container_name: 'aoba/many',
            source_status: 'open',
            source_due_on: null,
            source_updated_at: '2026-10-19T00:00:00.000Z',
            is_source_done: 0,
            missing_since_at: null,
            last_seen_at: '2026-10-19T00:00:00.000Z',
            created_at: '2026-10-19T00:00:00.000Z',
            updated_at: '2026-10-19T00:00:00.000Z',
          }),
        ),
      ]);
    }
    const body = (await (await list(target)).json()) as ListBody & {
      repositories: { id: string; name: string }[];
    };
    expect(body.tasks).toHaveLength(200);
    expect(body.total).toBe(201);
    expect(body.tasks[0]).toMatchObject({
      id: assigned.id,
      assignee: { id: target.member.userId },
      repository: { id: repository.id, name: 'shop' },
    });
    expect(body.repositories).toEqual([{ id: repository.id, name: 'shop' }]);
  }, 60_000);

  test('バックログの末尾の順は、届いた日時の順で、ID の順ではない', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const late = await arrive(target, connection.id, '2026-10-21T00:00:00.000Z', {}, 'aoba/shop#1');
    const early = await arrive(target, connection.id, '2026-10-19T00:00:00.000Z', {}, 'aoba/shop#2');
    expect((await move(target, [{ task_id: late.id }, { task_id: early.id }])).status).toBe(200);
    const a = (await rowOf(target, early.id))!;
    const b = (await rowOf(target, late.id))!;
    expect(a.position < b.position).toBe(true);
  });

  test('空の選び、101件、同じ ID の重複は 400', async () => {
    const target = await createTarget();
    const ids = Array.from({ length: 101 }, (_, index) => ({ task_id: `t${index}` }));
    expect((await move(target, [])).status).toBe(400);
    expect((await move(target, ids)).status).toBe(400);
    expect((await move(target, [{ task_id: 'a' }, { task_id: 'a' }])).status).toBe(400);
  });

  test('100件をまとめて移せる', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const tasks = [];
    for (let index = 0; index < 100; index++) {
      tasks.push(
        await arrive(
          target,
          connection.id,
          `2026-10-20T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
          {},
          `aoba/shop#${index + 1}`,
        ),
      );
    }
    const res = await move(
      target,
      tasks.map((task) => ({ task_id: task.id })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: 100 });
    const positions = new Set<string>();
    for (const task of tasks) positions.add((await rowOf(target, task.id))!.position);
    expect(positions.size).toBe(100);
  }, 60_000);

  test('閉じたワークスペースは 409 の workspace_closed で、何も移さない', async () => {
    const target = await createTarget();
    const connection = await connect(target);
    const task = await arrive(target, connection.id, '2026-10-20T00:00:00.000Z');
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-10-21T00:00:00.000Z' })
          .where('id', '=', target.workspace.id),
      ),
    );
    const res = await move(target, [{ task_id: task.id }]);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_closed');
    expect((await rowOf(target, task.id))!.tray).toBe('inbox');
  });
});
