// 削除の取り消し（task-restore）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { backlogTree, taskDelete, taskDetail, taskRestore } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { restoreBlockOf } from '../src/server/operations/task-restore.ts';
import { uuidv7 } from '../src/server/uuid.ts';
import { createCategory, createRepository, createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function remove(target: Target, taskId: string, person: Person = target.member) {
  return post(app, taskDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
}

function restore(target: Target, taskId: string, person: Person = target.member, requestEnv: Env = testEnv) {
  return post(app, taskRestore, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
    env: requestEnv,
  });
}

// 読んでから書くまでに別の要求が割り込んだ状況を作る。match に当たる問い合わせが答えた直後に、一度だけ change を流す
function racing(match: (sql: string) => boolean, change: () => Promise<void>): Env {
  let done = false;
  return envWithD1Hooks(testEnv, {
    afterQuery: async (sql) => {
      if (done || !match(sql)) return;
      done = true;
      await change();
    },
  });
}

// 削除したタスクと、親、担当、区分、リポジトリを読む問い合わせ
const readsTask = (sql: string) => sql.includes('from "tasks" left join "stories"');
// 担当が今も有効かを読む問い合わせ（activeMemberName）
const readsActiveMember = (sql: string) => sql.includes('inner join "users" as "u"');

async function nameOfUser(target: Target, userId: string) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(db.statement((q) => q.selectFrom('users').select('name').where('id', '=', userId)));
  return row!.name;
}

async function leaveWorkspace(target: Target, userId: string) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('memberships')
        .set({ left_at: '2026-10-22T00:00:00.000Z', left_on: '2026-10-22' })
        .where('user_id', '=', userId)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function writeDeleteLog(target: Target, taskId: string, actorUserId: string, at: string) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q.insertInto('change_logs').values({
        id: uuidv7(),
        organization_id: target.organization.id,
        workspace_id: target.workspace.id,
        actor_user_id: actorUserId,
        operator: null,
        entity_type: 'task',
        entity_id: taskId,
        action: 'delete',
        changes_json: JSON.stringify({ deleted_at: [null, at] }),
        created_at: at,
      }),
    ),
  );
}

async function rowOf(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('tasks').selectAll().where('id', '=', taskId).where('workspace_id', '=', target.workspace.id),
    ),
  );
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

async function reasonOf(res: Response) {
  return ((await res.clone().json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
}

describe('task-restore', () => {
  test('削除したタスクは、元の親と並びの位置に戻り、変更の履歴に戻した行が残る', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
      position: 'a5',
    });

    expect((await remove(target, task.id)).status).toBe(200);
    const deleted = (await rowOf(target, task.id))!;
    expect(deleted.deleted_at).not.toBeNull();

    const res = await restore(target, task.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_id: task.id, cleared: [] });

    const row = (await rowOf(target, task.id))!;
    expect(row.deleted_at).toBeNull();
    expect(row.updated_at).not.toBe(deleted.deleted_at);
    expect(row).toMatchObject({ story_id: story.id, position: 'a5', title: task.title, tray: 'backlog' });

    const logs = await logsOf(target, task.id);
    expect(logs.map((log) => log.action)).toEqual(['delete', 'restore']);
    expect(logs[1]).toMatchObject({ actor_user_id: target.member.userId });
    expect(JSON.parse(logs[1]!.changes_json)).toEqual({ deleted_at: [deleted.deleted_at, null] });

    expect(
      (
        await post(app, taskDetail, {
          slug: target.slug,
          token: target.member.token,
          body: { workspace_id: target.workspace.id, task_id: task.id },
        })
      ).status,
    ).toBe(200);
    const tree = (await (
      await post(app, backlogTree, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id },
      })
    ).json()) as { stories: { id: string; tasks: { id: string }[] }[] };
    expect(tree.stories.find((entry) => entry.id === story.id)?.tasks.map((entry) => entry.id)).toEqual([task.id]);
  });

  test('リーダーと管理者は、人が作ったタスクの削除も取り消せる', async () => {
    const target = await createTarget();
    for (const person of [target.leader, target.admin]) {
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
      expect((await remove(target, task.id, person)).status).toBe(200);
      expect((await restore(target, task.id, person)).status).toBe(200);
      expect((await rowOf(target, task.id))!.deleted_at).toBeNull();
    }
  });

  test('削除した人は、作った人でもリーダーでもなくても取り消せる。そうでない人は 403 で、何も書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    // リーダーだった本人が消した後に外れた場合を、メンバーが書いた削除の履歴で置く
    const db = orgDb(env, target.organization.verified);

    const forbidden = await restore(target, task.id, target.member);
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    expect((await rowOf(target, task.id))!.deleted_at).not.toBeNull();
    expect(await logsOf(target, task.id)).toEqual([]);

    await db.run(
      db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(),
          organization_id: target.organization.id,
          workspace_id: target.workspace.id,
          actor_user_id: target.member.userId!,
          operator: null,
          entity_type: 'task',
          entity_id: task.id,
          action: 'delete',
          changes_json: JSON.stringify({ deleted_at: [null, '2026-10-21T00:00:00.000Z'] }),
          created_at: '2026-10-21T00:00:00.000Z',
        }),
      ),
    );
    expect((await restore(target, task.id, target.member)).status).toBe(200);
    expect((await rowOf(target, task.id))!.deleted_at).toBeNull();
  });

  test('存在しないタスクは、権限より先に 404。別の組織と別のワークスペースのタスクも 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.admin.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.member.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (const id of [foreignTask.id, elsewhere.id, uuidv7()]) {
      const res = await restore(target, id, target.member);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await rowOf(foreign, foreignTask.id))!.deleted_at).not.toBeNull();
    expect((await rowOf({ ...target, workspace: target.otherWorkspace }, elsewhere.id))!.deleted_at).not.toBeNull();
  });

  test('削除していないタスクは 409 の not_deleted で、続けて戻しても履歴は増えない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const live = await restore(target, task.id);
    expect(live.status).toBe(409);
    expect(await reasonOf(live)).toBe('not_deleted');

    expect((await remove(target, task.id)).status).toBe(200);
    expect((await restore(target, task.id)).status).toBe(200);
    const again = await restore(target, task.id);
    expect(again.status).toBe(409);
    expect(await reasonOf(again)).toBe('not_deleted');
    expect((await logsOf(target, task.id)).map((log) => log.action)).toEqual(['delete', 'restore']);
  });

  test('親のストーリーが削除されているときは、親なしで戻し、外した親を履歴に残す', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const res = await restore(target, task.id);
    expect(res.status).toBe(200);
    expect((await rowOf(target, task.id))!).toMatchObject({ deleted_at: null, story_id: null });
    const logs = await logsOf(target, task.id);
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      deleted_at: ['2026-10-21T00:00:00.000Z', null],
      story: [{ id: story.id, title: story.title }, null],
    });
  });

  test('削除の間に所属を外れた担当と、削除された区分とリポジトリは、外して戻す（今日やるの印も外す）', async () => {
    const target = await createTarget();
    const outsider = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const db = orgDb(env, target.organization.verified);
    const category = await createCategory(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const repository = await createRepository(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      assignee_user_id: outsider.userId!,
      today_on: '2026-10-21',
      category_id: category.id,
      repository_id: repository.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: '2026-10-22T00:00:00.000Z', left_on: '2026-10-22' })
          .where('user_id', '=', outsider.userId!)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await restore(target, task.id)).status).toBe(200);
    expect(await rowOf(target, task.id)).toMatchObject({
      deleted_at: null,
      assignee_user_id: null,
      today_on: null,
      category_id: null,
      repository_id: null,
    });
    const logs = await logsOf(target, task.id);
    expect(Object.keys(JSON.parse(logs[0]!.changes_json)).sort()).toEqual([
      'assignee',
      'category',
      'deleted_at',
      'repository',
      'today_on',
    ]);
  });

  test('完了したタスクは、担当が所属を外れていても担当を替えずに戻す（退会が外すのは完了していないタスクだけ）', async () => {
    const target = await createTarget();
    const outsider = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const db = orgDb(env, target.organization.verified);
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      assignee_user_id: outsider.userId!,
      completed_at: '2026-10-19T00:00:00.000Z',
      completed_by: outsider.userId!,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: '2026-10-22T00:00:00.000Z', left_on: '2026-10-22' })
          .where('user_id', '=', outsider.userId!)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await restore(target, task.id)).status).toBe(200);
    expect(await rowOf(target, task.id)).toMatchObject({ deleted_at: null, assignee_user_id: outsider.userId });
  });

  test('親なしで戻すときは、親なしの並びの末尾に置く', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createTask(target.organization, target.workspace.id, target.member.userId!, { position: 'a5' });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
      position: 'a0',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    expect((await restore(target, task.id)).status).toBe(200);
    const row = (await rowOf(target, task.id))!;
    expect(row.story_id).toBeNull();
    expect(row.position > 'a5').toBe(true);
  });

  test('削除した人だけが戻せる場合も、戻した後の再送は 403 でなく 409 の not_deleted', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(),
          organization_id: target.organization.id,
          workspace_id: target.workspace.id,
          actor_user_id: target.member.userId!,
          operator: null,
          entity_type: 'task',
          entity_id: task.id,
          action: 'delete',
          changes_json: JSON.stringify({ deleted_at: [null, '2026-10-21T00:00:00.000Z'] }),
          created_at: '2026-10-21T00:00:00.000Z',
        }),
      ),
    );
    expect((await restore(target, task.id, target.member)).status).toBe(200);
    const again = await restore(target, task.id, target.member);
    expect(again.status).toBe(409);
    expect(await reasonOf(again)).toBe('not_deleted');
  });

  test('今の担当と区分はそのまま戻る', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      assignee_user_id: target.member.userId!,
      today_on: '2026-10-21',
    });
    expect((await remove(target, task.id)).status).toBe(200);
    expect((await restore(target, task.id)).status).toBe(200);
    expect(await rowOf(target, task.id)).toMatchObject({
      assignee_user_id: target.member.userId,
      today_on: '2026-10-21',
    });
    const logs = await logsOf(target, task.id);
    expect(Object.keys(JSON.parse(logs[1]!.changes_json))).toEqual(['deleted_at']);
  });

  test('完了したストーリーの下へは、完了していないタスクを戻せない（parent_completed）。完了したタスクは戻せる', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-20T00:00:00.000Z',
      completed_by: target.admin.userId!,
    });
    const open = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const done = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
      completed_at: '2026-10-19T00:00:00.000Z',
      completed_by: target.member.userId!,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const refused = await restore(target, open.id);
    expect(refused.status).toBe(409);
    expect(await reasonOf(refused)).toBe('parent_completed');
    expect((await rowOf(target, open.id))!.deleted_at).not.toBeNull();

    expect((await restore(target, done.id)).status).toBe(200);
    expect((await rowOf(target, done.id))!.deleted_at).toBeNull();
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const res = await restore(target, task.id, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect((await rowOf(target, task.id))!.deleted_at).not.toBeNull();
    expect(await logsOf(target, task.id)).toEqual([]);
  });

  test('無効にされた人が担当のタスクは、所属が残っていても担当を外して戻す（task-assign と同じ定義）', async () => {
    const target = await createTarget();
    const disabled = await createPerson({
      organization: target.organization,
      disabled: true,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      assignee_user_id: disabled.userId!,
      today_on: '2026-10-21',
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    expect((await restore(target, task.id)).status).toBe(200);
    expect(await rowOf(target, task.id)).toMatchObject({ deleted_at: null, assignee_user_id: null, today_on: null });
    const logs = await logsOf(target, task.id);
    expect(JSON.parse(logs[0]!.changes_json).assignee).toEqual([
      { id: disabled.userId, name: await nameOfUser(target, disabled.userId!) },
      null,
    ]);
  });

  test('外した担当、区分、リポジトリ、親の履歴は、担当、区分、リポジトリが {id, name}、親が {id, title}', async () => {
    const target = await createTarget();
    const outsider = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const category = await createCategory(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const repository = await createRepository(target.organization, target.workspace.id, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    // 親の下のタスクは区分を持たないので、親のあるタスクと親のないタスクの2つで確かめる
    const underStory = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
      assignee_user_id: outsider.userId!,
      repository_id: repository.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const loose = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      category_id: category.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await leaveWorkspace(target, outsider.userId!);
    const first = await restore(target, underStory.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ task_id: underStory.id, cleared: ['story', 'assignee', 'repository'] });
    const second = await restore(target, loose.id);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ task_id: loose.id, cleared: ['category'] });
    expect(JSON.parse((await logsOf(target, underStory.id))[0]!.changes_json)).toEqual({
      deleted_at: ['2026-10-21T00:00:00.000Z', null],
      story: [{ id: story.id, title: story.title }, null],
      assignee: [{ id: outsider.userId, name: await nameOfUser(target, outsider.userId!) }, null],
      repository: [{ id: repository.id, name: repository.name }, null],
    });
    expect(JSON.parse((await logsOf(target, loose.id))[0]!.changes_json)).toEqual({
      deleted_at: ['2026-10-21T00:00:00.000Z', null],
      category: [{ id: category.id, name: category.name }, null],
    });
  });

  describe('読んでから書くまでに変わったとき', () => {
    async function expectChanged(target: Target, taskId: string, res: Response) {
      expect(res.status).toBe(409);
      expect(await reasonOf(res)).toBe('changed');
      expect(await errorCodeOf(res)).toBe('conflict');
      expect((await rowOf(target, taskId))!.deleted_at).not.toBeNull();
      expect(await logsOf(target, taskId)).toEqual([]);
    }

    test('担当が退会したら、何も書かず 409 の changed', async () => {
      const target = await createTarget();
      const assignee = await createPerson({
        organization: target.organization,
        membership: { workspaceId: target.workspace.id, role: 'member' },
      });
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        assignee_user_id: assignee.userId!,
        deleted_at: '2026-10-21T00:00:00.000Z',
      });
      const raced = racing(readsActiveMember, () => leaveWorkspace(target, assignee.userId!));
      await expectChanged(target, task.id, await restore(target, task.id, target.member, raced));
    });

    test('担当が無効にされたら、何も書かず 409 の changed', async () => {
      const target = await createTarget();
      const assignee = await createPerson({
        organization: target.organization,
        membership: { workspaceId: target.workspace.id, role: 'member' },
      });
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        assignee_user_id: assignee.userId!,
        deleted_at: '2026-10-21T00:00:00.000Z',
      });
      const db = orgDb(env, target.organization.verified);
      const raced = racing(readsActiveMember, async () => {
        await db.run(
          db.statement((q) =>
            q.updateTable('users').set({ disabled_at: '2026-10-22T00:00:00.000Z' }).where('id', '=', assignee.userId!),
          ),
        );
      });
      await expectChanged(target, task.id, await restore(target, task.id, target.member, raced));
    });

    test('残す区分が削除されたら、何も書かず 409 の changed', async () => {
      const target = await createTarget();
      const category = await createCategory(target.organization, target.workspace.id);
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        category_id: category.id,
        deleted_at: '2026-10-21T00:00:00.000Z',
      });
      const db = orgDb(env, target.organization.verified);
      const raced = racing(readsTask, async () => {
        await db.run(
          db.statement((q) =>
            q.updateTable('categories').set({ deleted_at: '2026-10-22T00:00:00.000Z' }).where('id', '=', category.id),
          ),
        );
      });
      await expectChanged(target, task.id, await restore(target, task.id, target.member, raced));
    });

    test('参照が別のものに替わったら、何も書かず 409 の changed', async () => {
      const target = await createTarget();
      const category = await createCategory(target.organization, target.workspace.id);
      const other = await createCategory(target.organization, target.workspace.id, { position: 'a1' });
      const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
        category_id: category.id,
        deleted_at: '2026-10-21T00:00:00.000Z',
      });
      const db = orgDb(env, target.organization.verified);
      const raced = racing(readsTask, async () => {
        await db.run(
          db.statement((q) => q.updateTable('tasks').set({ category_id: other.id }).where('id', '=', task.id)),
        );
      });
      await expectChanged(target, task.id, await restore(target, task.id, target.member, raced));
    });
  });

  test('削除した人の判定は今の削除の履歴だけを見る。古い削除の履歴だけの人は 403、今の削除を書いた人は 200', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    // 前に消して戻した分の履歴（今の deleted_at とは別の日時）だけがある人は、今の削除を書いていない
    await writeDeleteLog(target, task.id, target.member.userId!, '2026-10-10T00:00:00.000Z');
    const forbidden = await restore(target, task.id, target.member);
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    expect((await rowOf(target, task.id))!.deleted_at).not.toBeNull();

    // 今の deleted_at と同じ日時の削除の履歴を書いた人は戻せる
    await writeDeleteLog(target, task.id, target.member.userId!, '2026-10-21T00:00:00.000Z');
    expect((await restore(target, task.id, target.member)).status).toBe(200);
    expect((await rowOf(target, task.id))!.deleted_at).toBeNull();
  });

  test('削除済みで完了済みの親の下のタスクは、完了していなくても親なしで戻る（parent_completed にしない）', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-20T00:00:00.000Z',
      completed_by: target.admin.userId!,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    expect((await restore(target, task.id)).status).toBe(200);
    expect(await rowOf(target, task.id)).toMatchObject({ deleted_at: null, story_id: null });
    expect(JSON.parse((await logsOf(target, task.id))[0]!.changes_json).story).toEqual([
      { id: story.id, title: story.title },
      null,
    ]);
  });
});

describe('restoreBlockOf', () => {
  const base = {
    deletedAt: '2026-10-21T00:00:00.000Z',
    completedAt: null,
    storyDeletedAt: null,
    storyCompletedAt: null,
    hasStory: true,
  };
  test.each([
    ['削除していない', { deletedAt: null }, 'not_deleted'],
    ['親なし', { hasStory: false }, null],
    ['親が削除されている（親なしで戻す）', { storyDeletedAt: '2026-10-21T00:00:00.000Z' }, null],
    ['親が完了し、タスクは未完了', { storyCompletedAt: '2026-10-20T00:00:00.000Z' }, 'parent_completed'],
    [
      '親が完了し、タスクも完了',
      { storyCompletedAt: '2026-10-20T00:00:00.000Z', completedAt: '2026-10-19T00:00:00.000Z' },
      null,
    ],
    ['親が生きている', {}, null],
  ])('%s', (_name, override, expected) => {
    expect(restoreBlockOf({ ...base, ...override })).toBe(expected);
  });
});

describe('task-restore の削除した人', () => {
  test('削除が複数回あるときは、今の削除を書いた人だけが（作った人でもリーダーでもなければ）戻せる', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      deleted_at: '2026-10-23T00:00:00.000Z',
    });
    const db = orgDb(env, target.organization.verified);
    const logOf = (actorUserId: string, createdAt: string) =>
      db.run(
        db.statement((q) =>
          q.insertInto('change_logs').values({
            id: uuidv7(),
            organization_id: target.organization.id,
            workspace_id: target.workspace.id,
            actor_user_id: actorUserId,
            operator: null,
            entity_type: 'task',
            entity_id: task.id,
            action: 'delete',
            changes_json: JSON.stringify({ deleted_at: [null, createdAt] }),
            created_at: createdAt,
          }),
        ),
      );
    // 前の削除はメンバー、今の削除（deleted_at と同じ時刻）は管理者
    await logOf(target.member.userId!, '2026-10-21T00:00:00.000Z');
    await logOf(target.admin.userId!, '2026-10-23T00:00:00.000Z');
    const res = await restore(target, task.id, target.member);
    expect(res.status).toBe(403);
    expect((await rowOf(target, task.id))!.deleted_at).not.toBeNull();
  });
});
