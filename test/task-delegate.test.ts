// #904: 依頼先と担当を一緒に変え、履歴と討伐隊を同じ書き込みで揃える。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, runStatementsForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { delegateeCreate, delegateeDelete } from '../src/shared/operations/organization/index.ts';
import {
  taskComplete,
  taskDelegate,
  taskDetail,
  taskHistory,
  taskReopen,
} from '../src/shared/operations/task/index.ts';
import { afterFirstQuery } from './auth/helpers.ts';
import { createEpic, createMembership, createStory, createTask, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import {
  createPersonalTarget as createPersonalTargetWithoutMembership,
  createTarget,
  testEnv,
  type Target,
} from './operations/world.ts';

const app = createApp(implementedOperations);
async function createPersonalTarget() {
  const target = await createPersonalTargetWithoutMembership();
  await createMembership(target.organization, target.workspace.id, target.admin.userId!);
  return target;
}
type Delegatee = { id: string; name: string };
async function add(target: Target, name = '青葉 透'): Promise<Delegatee> {
  const res = await post(app, delegateeCreate, { slug: target.slug, token: target.admin.token, body: { name } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { delegatee: Delegatee }).delegatee;
}
function delegate(target: Target, taskId: string, delegateeId: string | null, requestEnv?: Env) {
  return post(app, taskDelegate, {
    slug: target.slug,
    token: target.admin.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, delegatee_id: delegateeId },
    ...(requestEnv ? { env: requestEnv } : {}),
  });
}
async function row(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', taskId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}
async function logs(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', target.organization.id)
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', taskId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}
async function detail(target: Target, taskId: string) {
  const res = await post(app, taskDetail, {
    slug: target.slug,
    token: target.admin.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { task: { delegatee: Delegatee | null; assignee: { id: string; name: string } | null } };
}

describe('task-delegate', () => {
  test('完了を戻す直前に名簿が削除されたら競合にし、読み直して解除する', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    expect((await delegate(target, task.id, person.id)).status).toBe(200);
    const body = { workspace_id: target.workspace.id, task_id: task.id };
    expect((await post(app, taskComplete, { slug: target.slug, token: target.admin.token, body })).status).toBe(200);
    let raced = false;
    const racing = envWithD1Hooks(testEnv, {
      async afterBatch(sqls) {
        if (!raced && sqls.some((sql) => sql.includes('from "tasks"') && sql.includes('join "delegatees"'))) {
          raced = true;
          expect(
            (
              await post(app, delegateeDelete, {
                slug: target.slug,
                token: target.admin.token,
                body: { delegatee_id: person.id },
              })
            ).status,
          ).toBe(200);
        }
      },
    });
    expect(
      (await post(app, taskReopen, { slug: target.slug, token: target.admin.token, body, env: racing })).status,
    ).toBe(409);
    expect(raced).toBe(true);
    expect((await row(target, task.id))!.completed_at).not.toBeNull();
    expect((await post(app, taskReopen, { slug: target.slug, token: target.admin.token, body })).status).toBe(200);
    expect((await detail(target, task.id)).task.delegatee).toBeNull();
  });
  test.each([false, true])('完了を戻すと、削除済みの依頼先だけを外す（削除: %s）', async (deleted) => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    expect((await delegate(target, task.id, person.id)).status).toBe(200);
    const body = { workspace_id: target.workspace.id, task_id: task.id };
    expect((await post(app, taskComplete, { slug: target.slug, token: target.admin.token, body })).status).toBe(200);
    if (deleted)
      expect(
        (
          await post(app, delegateeDelete, {
            slug: target.slug,
            token: target.admin.token,
            body: { delegatee_id: person.id },
          })
        ).status,
      ).toBe(200);
    expect((await post(app, taskReopen, { slug: target.slug, token: target.admin.token, body })).status).toBe(200);
    expect((await detail(target, task.id)).task.delegatee).toEqual(deleted ? null : person);
    if (deleted) {
      const reopened = (await logs(target, task.id)).find((log) => log.action === 'reopen')!;
      expect(JSON.parse(reopened.changes_json).delegatee).toEqual([person, null]);
    }
  });

  test('所属していない管理者を自動担当にせず404で断る', async () => {
    const target = await createPersonalTargetWithoutMembership();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    expect((await delegate(target, task.id, person.id)).status).toBe(404);
    expect(await row(target, task.id)).toEqual(task);
    expect(await logs(target, task.id)).toEqual([]);
  });

  test('担当なしに依頼先を付けると担当が自分になり、詳細と履歴に両方の変化が出る。外しても担当と今日の印を残す', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      today_on: '2026-11-10',
    });
    expect((await detail(target, task.id)).task.delegatee).toBeNull();
    const res = await delegate(target, task.id, person.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: task.id });
    const assigned = (await detail(target, task.id)).task.assignee!;
    expect(assigned.id).toBe(target.admin.userId);
    expect((await detail(target, task.id)).task.delegatee).toEqual(person);
    expect((await row(target, task.id))!.today_on).toBe('2026-11-10');
    const history = await post(app, taskHistory, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id, task_id: task.id },
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      entries: [
        {
          action: 'update',
          changes: expect.arrayContaining([
            { field: 'delegatee', before: null, after: person },
            { field: 'assignee', before: null, after: { id: assigned.id, name: assigned.name } },
          ]),
        },
      ],
    });
    expect((await delegate(target, task.id, null)).status).toBe(200);
    expect((await detail(target, task.id)).task).toMatchObject({
      delegatee: null,
      assignee: { id: target.admin.userId },
    });
    expect((await row(target, task.id))!.today_on).toBe('2026-11-10');
    expect(JSON.parse((await logs(target, task.id)).at(-1)!.changes_json)).toEqual({ delegatee: [person, null] });
  });

  test('担当が既にあれば変えず、同じ依頼先をもう一度指定しても履歴を増やさない', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      assignee_user_id: target.extra.userId,
    });
    expect((await delegate(target, task.id, person.id)).status).toBe(200);
    expect((await delegate(target, task.id, person.id)).status).toBe(200);
    expect((await row(target, task.id))!.assignee_user_id).toBe(target.extra.userId);
    const changes = (await logs(target, task.id)).map((log) => JSON.parse(log.changes_json));
    expect(changes).toEqual([{ delegatee: [null, person] }]);
  });

  test('依頼先なしを外しても担当なしのまま、何も履歴を書かない', async () => {
    const target = await createPersonalTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    expect((await delegate(target, task.id, null)).status).toBe(200);
    expect((await row(target, task.id))!.assignee_user_id).toBeNull();
    expect(await logs(target, task.id)).toEqual([]);
  });

  test('自分を担当にすると、親エピックの討伐隊にも1回だけ加える', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!);
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
    });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
    });
    expect((await delegate(target, task.id, person.id)).status).toBe(200);
    expect((await delegate(target, task.id, person.id)).status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    const party = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('epic_party_members')
          .innerJoin('epics', 'epics.id', 'epic_party_members.epic_id')
          .selectAll('epic_party_members')
          .where('epics.workspace_id', '=', target.workspace.id)
          .where('epic_id', '=', epic.id),
      ),
    );
    expect(party).toHaveLength(1);
    expect(party[0]).toMatchObject({
      user_id: target.admin.userId,
      joined_via: 'task_assignee',
      added_by: target.admin.userId,
    });
  });

  test('完了したときの経験値と完了の記録は担当の自分に付く', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { points: 3 });
    expect((await delegate(target, task.id, person.id)).status).toBe(200);
    const complete = await post(app, taskComplete, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id, task_id: task.id },
    });
    expect(complete.status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    const completions = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('completions')
          .selectAll()
          .where('workspace_id', '=', target.workspace.id)
          .where('task_id', '=', task.id),
      ),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ assignee_user_id: target.admin.userId });
    const xp = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('xp_grants')
          .selectAll()
          .where('workspace_id', '=', target.workspace.id)
          .where('task_id', '=', task.id),
      ),
    );
    expect(xp.length).toBeGreaterThan(0);
    expect(xp.every((grant) => grant.user_id === target.admin.userId)).toBe(true);
  });

  test('別組織・削除済み・存在しない依頼先は404で何も変えない', async () => {
    const target = await createPersonalTarget();
    const foreign = await createPersonalTarget();
    const foreignPerson = await add(foreign);
    const deleted = await add(target);
    expect(
      (
        await post(app, delegateeDelete, {
          slug: target.slug,
          token: target.admin.token,
          body: { delegatee_id: deleted.id },
        })
      ).status,
    ).toBe(200);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    for (const id of [foreignPerson.id, deleted.id, uuidv7()])
      expect((await delegate(target, task.id, id)).status).toBe(404);
    expect(await row(target, task.id)).toEqual(task);
    expect(await logs(target, task.id)).toEqual([]);
  });

  test('別組織・別ワークスペース・削除済み・受信箱・存在しないタスクは404', async () => {
    const target = await createPersonalTarget();
    const foreign = await createPersonalTarget();
    const person = await add(target);
    const tasks = await Promise.all([
      createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!),
      createTask(target.organization, target.otherWorkspace.id, target.admin.userId!),
      createTask(target.organization, target.workspace.id, target.admin.userId!, {
        deleted_at: '2026-10-22T00:00:00.000Z',
      }),
      createTask(target.organization, target.workspace.id, target.admin.userId!, { tray: 'inbox', is_imported: 1 }),
    ]);
    for (const taskId of [...tasks.map((task) => task.id), uuidv7()])
      expect((await delegate(target, taskId, person.id)).status).toBe(404);
  });

  test('完了済みタスク・閉じたワークスペースは409で変更しない', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-22T00:00:00.000Z',
      completed_by: target.admin.userId,
    });
    expect((await delegate(target, task.id, person.id)).status).toBe(409);
    expect(await row(target, task.id)).toEqual(task);
    const open = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-10-22T00:00:00.000Z' })
          .where('organization_id', '=', target.organization.id)
          .where('id', '=', target.workspace.id),
      ),
    );
    expect((await delegate(target, open.id, person.id)).status).toBe(409);
    expect(await row(target, open.id)).toEqual(open);
  });

  test('チーム用は409 team_organizationで、タスクも履歴も変えない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const res = await delegate(target, task.id, null);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'team_organization' } } });
    expect(await row(target, task.id)).toEqual(task);
    expect(await logs(target, task.id)).toEqual([]);
  });

  test('読んだ後に別の依頼先が付いても読み直し、直前の値を履歴に残す', async () => {
    const target = await createPersonalTarget();
    const first = await add(target);
    const second = await add(target, '若葉 澪');
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    let raced = false;
    const racing = afterFirstQuery(
      testEnv,
      (sql) => sql.includes('from "tasks"'),
      async () => {
        raced = true;
        expect((await delegate(target, task.id, first.id)).status).toBe(200);
      },
    );
    expect((await delegate(target, task.id, second.id, racing)).status).toBe(200);
    expect(raced).toBe(true);
    expect((await row(target, task.id))!.delegatee_id).toBe(second.id);
    const changes = (await logs(target, task.id)).map((log) => JSON.parse(log.changes_json));
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({ delegatee: [first, second] });
  });

  test('競合が続くと有限回の読み直しで409になり、失敗した要求の履歴を書かない', async () => {
    const target = await createPersonalTarget();
    const first = await add(target);
    const second = await add(target, '若葉 澪');
    const wanted = await add(target, '空野 凪');
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    let races = 0;
    const db = orgDb(env, target.organization.verified);
    const racing = envWithD1Hooks(testEnv, {
      async afterQuery(sql) {
        if (!sql.includes('from "tasks"')) return;
        races++;
        if (races > 4) throw new Error('retry limit exceeded');
        await db.run(
          db.statement((q) =>
            q
              .updateTable('tasks')
              .set({ delegatee_id: races % 2 ? first.id : second.id })
              .where('workspace_id', '=', target.workspace.id)
              .where('id', '=', task.id),
          ),
        );
      },
    });
    const res = await delegate(target, task.id, wanted.id, racing);
    expect(res.status).toBe(409);
    expect(races).toBeGreaterThan(1);
    expect(races).toBeLessThanOrEqual(4);
    expect((await row(target, task.id))!.delegatee_id).not.toBe(wanted.id);
    expect((await row(target, task.id))!.assignee_user_id).toBeNull();
    expect(await logs(target, task.id)).toEqual([]);
  });

  test('読んだ後に依頼先を消されたら404。担当と履歴を書き残さない', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    let raced = false;
    const racing = afterFirstQuery(
      testEnv,
      (sql) => sql.includes('from "tasks"'),
      async () => {
        raced = true;
        expect(
          (
            await post(app, delegateeDelete, {
              slug: target.slug,
              token: target.admin.token,
              body: { delegatee_id: person.id },
            })
          ).status,
        ).toBe(200);
      },
    );
    expect((await delegate(target, task.id, person.id, racing)).status).toBe(404);
    expect(raced).toBe(true);
    expect(await row(target, task.id)).toEqual(task);
    expect(await logs(target, task.id)).toEqual([]);
  });

  test('読んだ後に完了になったら409で依頼先・自動担当を付けない', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    let raced = false;
    const racing = afterFirstQuery(
      testEnv,
      (sql) => sql.includes('from "tasks"'),
      async () => {
        raced = true;
        expect(
          (
            await post(app, taskComplete, {
              slug: target.slug,
              token: target.admin.token,
              body: { workspace_id: target.workspace.id, task_id: task.id },
            })
          ).status,
        ).toBe(200);
      },
    );
    expect((await delegate(target, task.id, person.id, racing)).status).toBe(409);
    expect(raced).toBe(true);
    const current = await row(target, task.id);
    expect(current!.delegatee_id).toBeNull();
    expect(current!.assignee_user_id).toBeNull();
    expect((await logs(target, task.id)).filter((log) => log.action === 'update')).toEqual([]);
  });

  test('タスクの書き込み失敗で依頼先・担当・討伐隊・変更履歴はすべて元のまま', async () => {
    const target = await createPersonalTarget();
    const person = await add(target);
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!);
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
    });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      story_id: story.id,
    });
    await runStatementsForTest(env, [
      `CREATE TRIGGER reject_task_delegate_log_test BEFORE INSERT ON change_logs
       WHEN NEW.entity_id = '${task.id}' AND NEW.action = 'update'
       BEGIN SELECT RAISE(ABORT, 'simulated second statement failure'); END`,
    ]);
    try {
      expect((await delegate(target, task.id, person.id)).status).toBe(500);
    } finally {
      await runStatementsForTest(env, ['DROP TRIGGER reject_task_delegate_log_test']);
    }
    expect(await row(target, task.id)).toEqual(task);
    expect(await logs(target, task.id)).toEqual([]);
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.rows(
        db.statement((q) =>
          q
            .selectFrom('epic_party_members')
            .innerJoin('epics', 'epics.id', 'epic_party_members.epic_id')
            .select('epic_party_members.user_id')
            .where('epics.workspace_id', '=', target.workspace.id)
            .where('epic_id', '=', epic.id),
        ),
      ),
    ).toEqual([]);
  });
});
