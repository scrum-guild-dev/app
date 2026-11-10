// #904: 自分用の名簿と、名簿削除時のタスクの履歴・完了した名前を確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { runStatementsForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  delegateeCreate,
  delegateeDelete,
  delegateeList,
  delegateeUpdate,
} from '../src/shared/operations/organization/index.ts';
import { taskDetail } from '../src/shared/operations/task/index.ts';
import { createDelegatee, createTask, createWorkspace, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPersonalTarget, createTarget, testEnv, type Target } from './operations/world.ts';

type Delegatee = { id: string; name: string };
const app = createApp(implementedOperations);
function call(
  target: Target,
  definition: typeof delegateeCreate | typeof delegateeUpdate | typeof delegateeDelete | typeof delegateeList,
  body: unknown = {},
) {
  return post(app, definition, { slug: target.slug, token: target.admin.token, body });
}
async function add(target: Target, name = '青葉 透'): Promise<Delegatee> {
  const res = await call(target, delegateeCreate, { name });
  expect(res.status).toBe(200);
  return ((await res.json()) as { delegatee: Delegatee }).delegatee;
}
async function list(target: Target): Promise<Delegatee[]> {
  const res = await call(target, delegateeList);
  expect(res.status).toBe(200);
  return ((await res.json()) as { delegatees: Delegatee[] }).delegatees;
}
async function logs(target: Target) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) => q.selectFrom('change_logs').selectAll().where('organization_id', '=', target.organization.id)),
  );
}

describe('依頼先の名簿', () => {
  test('件数上限の最後の枠に並行登録しても50人まで。削除後は枠を再利用できる', async () => {
    const target = await createPersonalTarget();
    for (let n = 0; n < 49; n++) await createDelegatee(target.organization, { name: `名簿-${n}` });
    const responses = await Promise.all([
      call(target, delegateeCreate, { name: '最後の候補1' }),
      call(target, delegateeCreate, { name: '最後の候補2' }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const refused = responses.find((res) => res.status === 409)!;
    expect(await refused.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'limit' } } });
    const people = await list(target);
    expect(people).toHaveLength(50);
    expect((await call(target, delegateeDelete, { delegatee_id: people[0]!.id })).status).toBe(200);
    expect((await call(target, delegateeCreate, { name: '削除した枠' })).status).toBe(200);
    expect(await list(target)).toHaveLength(50);
  });

  test('追加・名前変更・名前順の一覧。名前の前後の空白を除く', async () => {
    const target = await createPersonalTarget();
    const second = await add(target, '  いろは 透  ');
    const first = await add(target, 'あおば 澪');
    expect(second.name).toBe('いろは 透');
    expect(await list(target)).toEqual([first, second]);
    const res = await call(target, delegateeUpdate, { delegatee_id: second.id, name: '  うたかた 透  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delegatee: { id: second.id, name: 'うたかた 透' } });
    expect(await list(target)).toEqual([first, { id: second.id, name: 'うたかた 透' }]);
    expect(
      (await logs(target)).map((row) => ({
        type: row.entity_type,
        action: row.action,
        changes: JSON.parse(row.changes_json),
      })),
    ).toEqual([
      { type: 'delegatee', action: 'create', changes: expect.any(Object) },
      { type: 'delegatee', action: 'create', changes: expect.any(Object) },
      { type: 'delegatee', action: 'update', changes: { name: ['いろは 透', 'うたかた 透'] } },
    ]);
  });

  test('重名の追加・変更は409。自分の名前のままなら通り、消した名前は再使用できる', async () => {
    const target = await createPersonalTarget();
    const first = await add(target, '青葉 透');
    const second = await add(target, '若葉 澪');
    for (const [definition, body] of [
      [delegateeCreate, { name: first.name }],
      [delegateeUpdate, { delegatee_id: second.id, name: first.name }],
    ] as const) {
      const res = await call(target, definition, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'duplicate_name' } } });
    }
    expect((await call(target, delegateeUpdate, { delegatee_id: first.id, name: first.name })).status).toBe(200);
    expect((await call(target, delegateeDelete, { delegatee_id: first.id })).status).toBe(200);
    const replacement = await add(target, first.name);
    expect(replacement.id).not.toBe(first.id);
    expect(await list(target)).toHaveLength(2);
  });

  test('同じ名前を並行して追加しても1件だけ成功する', async () => {
    const target = await createPersonalTarget();
    const responses = await Promise.all([
      call(target, delegateeCreate, { name: '青葉 透' }),
      call(target, delegateeCreate, { name: '青葉 透' }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await list(target)).toHaveLength(1);
  });

  test.each(['', '   ', 'あ'.repeat(51)])('無効な名前を断る: %j', async (name) => {
    const target = await createPersonalTarget();
    const row = await add(target);
    for (const [definition, body] of [
      [delegateeCreate, { name }],
      [delegateeUpdate, { delegatee_id: row.id, name }],
    ] as const) {
      expect((await call(target, definition, body)).status).toBe(400);
    }
  });

  test('別組織・存在しない・削除済みの依頼先は同じ404。別組織の名簿は一覧に出ない', async () => {
    const own = await createPersonalTarget();
    const other = await createPersonalTarget();
    const foreign = await add(other);
    const deleted = await add(own);
    expect((await call(own, delegateeDelete, { delegatee_id: deleted.id })).status).toBe(200);
    for (const id of [foreign.id, deleted.id, uuidv7()]) {
      expect((await call(own, delegateeUpdate, { delegatee_id: id, name: '若葉 澪' })).status).toBe(404);
      expect((await call(own, delegateeDelete, { delegatee_id: id })).status).toBe(404);
    }
    expect(await list(own)).toEqual([]);
    expect(await list(other)).toEqual([foreign]);
  });

  test('チーム用の書き込みは409で名簿・タスク・履歴を変えない。読み取りは許す', async () => {
    const target = await createTarget();
    for (const [definition, body] of [
      [delegateeCreate, { name: '青葉 透' }],
      [delegateeUpdate, { delegatee_id: uuidv7(), name: '青葉 透' }],
      [delegateeDelete, { delegatee_id: uuidv7() }],
    ] as const) {
      const res = await call(target, definition, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'team_organization' } } });
    }
    expect(await list(target)).toEqual([]);
    expect(await logs(target)).toEqual([]);
  });

  test('名簿の削除は未完了の全タスクから外し、完了したタスクには名前を残す', async () => {
    const target = await createPersonalTarget();
    const delegatee = await add(target);
    const other = await add(target, '若葉 澪');
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      closed_at: '2026-10-22T00:00:00.000Z',
    });
    const tasks = await Promise.all([
      createTask(target.organization, target.workspace.id, target.admin.userId!, { delegatee_id: delegatee.id }),
      createTask(target.organization, target.otherWorkspace.id, target.admin.userId!, { delegatee_id: delegatee.id }),
      createTask(target.organization, closed.id, target.admin.userId!, { delegatee_id: delegatee.id }),
      createTask(target.organization, target.workspace.id, target.admin.userId!, {
        delegatee_id: delegatee.id,
        deleted_at: '2026-10-23T00:00:00.000Z',
      }),
    ]);
    const completed = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      delegatee_id: delegatee.id,
      completed_at: '2026-10-22T00:00:00.000Z',
      completed_by: target.admin.userId,
    });
    const untouched = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      delegatee_id: other.id,
    });
    const foreign = await createPersonalTarget();
    const foreignDelegatee = await add(foreign);
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!, {
      delegatee_id: foreignDelegatee.id,
    });
    expect((await call(target, delegateeDelete, { delegatee_id: delegatee.id })).status).toBe(200);
    expect(await list(target)).toEqual([other]);
    const db = orgDb(env, target.organization.verified);
    for (const task of tasks) {
      const row = await db.first(
        db.statement((q) =>
          q.selectFrom('tasks').selectAll().where('id', '=', task.id).where('workspace_id', '=', task.workspace_id),
        ),
      );
      expect(row!.delegatee_id).toBeNull();
      const taskLog = (await logs(target)).filter((log) => log.entity_id === task.id);
      expect(taskLog).toHaveLength(1);
      expect(JSON.parse(taskLog[0]!.changes_json)).toEqual({ delegatee: [delegatee, null] });
    }
    const read = await post(app, taskDetail, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id, task_id: completed.id },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ task: { delegatee } });
    const same = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', untouched.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(same!.delegatee_id).toBe(other.id);
    expect((await logs(target)).filter((log) => log.entity_id === completed.id)).toEqual([]);
    expect(
      (await logs(target)).filter((log) => log.entity_id === delegatee.id && log.action === 'delete'),
    ).toHaveLength(1);
    const foreignDb = orgDb(env, foreign.organization.verified);
    expect(
      (await foreignDb.first(
        foreignDb.statement((q) =>
          q
            .selectFrom('tasks')
            .select('delegatee_id')
            .where('workspace_id', '=', foreign.workspace.id)
            .where('id', '=', foreignTask.id),
        ),
      ))!.delegatee_id,
    ).toBe(foreignDelegatee.id);
  });
  test('名簿削除の書き込みが失敗すると、名簿・タスク・履歴をまとめて元に保つ', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      delegatee_id: person.id,
    });
    const originalLogs = await logs(target);
    await runStatementsForTest(env, [
      `CREATE TRIGGER reject_delegatee_unset_test BEFORE UPDATE OF delegatee_id ON tasks
       WHEN OLD.delegatee_id = '${person.id}' AND NEW.delegatee_id IS NULL
       BEGIN SELECT RAISE(ABORT, 'simulated last statement failure'); END`,
    ]);
    let res: Response;
    try {
      res = await post(app, delegateeDelete, {
        slug: target.slug,
        token: target.admin.token,
        body: { delegatee_id: person.id },
      });
    } finally {
      await runStatementsForTest(env, ['DROP TRIGGER reject_delegatee_unset_test']);
    }
    expect(res.status).toBe(500);
    expect(await list(target)).toEqual([person]);
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.first(
        db.statement((q) =>
          q.selectFrom('tasks').selectAll().where('workspace_id', '=', target.workspace.id).where('id', '=', task.id),
        ),
      ),
    ).toEqual(task);
    expect(await logs(target)).toEqual(originalLogs);
  });
});
