// 削除の取り消し（task-restore）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { backlogTree, taskDelete, taskDetail, taskRestore } from '../src/shared/operations/task/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { restoreBlockOf } from '../src/server/operations/task-restore.ts';
import { uuidv7 } from '../src/server/uuid.ts';
import { createCategory, createRepository, createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function remove(target: Target, taskId: string, person: Person = target.member) {
  return post(app, taskDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
}

function restore(target: Target, taskId: string, person: Person = target.member) {
  return post(app, taskRestore, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId },
  });
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
    expect(await res.json()).toEqual({ task_id: task.id });

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
      story_id: [story.id, null],
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
      'assignee_user_id',
      'category_id',
      'deleted_at',
      'repository_id',
      'today_on',
    ]);
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
