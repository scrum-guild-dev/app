// エピックの中止と取り消し。登録の一覧は組織の分離と権限の種類も確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  epicCancel,
  epicComplete,
  epicPartyAssign,
  epicPartyJoin,
  epicRewardUpdate,
  epicUncancel,
} from '../src/shared/operations/epic/index.ts';
import { storyComplete, storyReopen } from '../src/shared/operations/story/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  AT,
  createEpic,
  createEpicPartyMember,
  createStory,
  createTask,
  createWorkspace,
  createXpGrant,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function call(
  definition: AnyOperationDefinition,
  target: Target,
  epicId: string,
  person: Person = target.leader,
  requestEnv: Env = testEnv,
  extra: Record<string, unknown> = {},
) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId, ...extra },
    env: requestEnv,
  });
}

function epicOf(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  return createEpic(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

async function rowOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return (await db.first(
    db.statement((q) =>
      q.selectFrom('epics').selectAll().where('workspace_id', '=', target.workspace.id).where('id', '=', epicId),
    ),
  ))!;
}

async function logsOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('workspace_id', '=', target.workspace.id)
        .where('entity_type', '=', 'epic')
        .where('entity_id', '=', epicId)
        .orderBy('id'),
    ),
  );
}

async function xpOf(target: Target) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('xp_grants').selectAll().where('workspace_id', '=', target.workspace.id).orderBy('id'),
    ),
  );
}

// API がエピックを読んだ後、書き込む前に別の要求を完了させる。
function racing(change: () => Promise<void>): Env {
  let done = false;
  const interrupt = async (sqls: readonly string[]) => {
    if (done || !sqls.some((sql) => sql.startsWith('select ') && sql.includes('from "epics"'))) return;
    done = true;
    await change();
  };
  return envWithD1Hooks(testEnv, {
    afterQuery: (sql) => interrupt([sql]),
    afterBatch: interrupt,
  });
}

describe('epic-cancel / epic-uncancel', () => {
  test.each(['admin', 'leader', 'member'] as const)('%s は依頼主かリーダーなら中止し、取り消せる', async (role) => {
    const target = await createTarget();
    const person = target[role];
    const epic = await epicOf(target, { requester_user_id: role === 'member' ? person.userId! : target.admin.userId! });
    const res = await call(epicCancel, target, epic.id, person);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epic_id: epic.id });
    const canceled = await rowOf(target, epic.id);
    expect(canceled.canceled_at).not.toBeNull();
    expect(canceled.canceled_by).toBe(person.userId);
    expect(canceled.completed_at).toBeNull();
    expect(canceled.updated_at).toBe(canceled.canceled_at);
    expect((await call(epicUncancel, target, epic.id, person)).status).toBe(200);
    const restored = await rowOf(target, epic.id);
    expect(restored.canceled_at).toBeNull();
    expect(restored.canceled_by).toBeNull();
    const logs = await logsOf(target, epic.id);
    expect(logs.map((log) => [log.action, log.actor_user_id])).toEqual([
      ['cancel', person.userId],
      ['uncancel', person.userId],
    ]);
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      canceled_at: [null, canceled.canceled_at],
      canceled_by: [null, { id: person.userId, name: expect.any(String) }],
    });
    expect(JSON.parse(logs[1]!.changes_json)).toEqual({
      canceled_at: [canceled.canceled_at, null],
      canceled_by: [{ id: person.userId, name: expect.any(String) }, null],
    });
  });

  test('依頼主でもリーダーでもないメンバーには両方とも403で、履歴も書かない', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    expect((await call(epicCancel, target, epic.id, target.member)).status).toBe(403);
    expect((await rowOf(target, epic.id)).canceled_at).toBeNull();
    expect(await logsOf(target, epic.id)).toEqual([]);
    expect((await call(epicCancel, target, epic.id)).status).toBe(200);
    expect((await call(epicUncancel, target, epic.id, target.member)).status).toBe(403);
    expect((await rowOf(target, epic.id)).canceled_at).not.toBeNull();
    expect(await logsOf(target, epic.id)).toHaveLength(1);
  });

  test('完了したレイドの中止と取り消しは409で、完了の印を変えない', async () => {
    const target = await createTarget();
    const epic = await epicOf(target, { completed_at: AT, completed_by: target.admin.userId! });
    for (const definition of [epicCancel, epicUncancel]) {
      const res = await call(definition, target, epic.id);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('epic_finished');
    }
    expect((await rowOf(target, epic.id)).completed_at).toBe(AT);
    expect(await logsOf(target, epic.id)).toEqual([]);
  });

  test('未中止の取り消しと二重の中止は409で、二重の履歴を書かない', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    const absent = await call(epicUncancel, target, epic.id);
    expect(absent.status).toBe(409);
    expect(await errorCodeOf(absent)).toBe('conflict');
    expect((await call(epicCancel, target, epic.id)).status).toBe(200);
    const twice = await call(epicCancel, target, epic.id);
    expect(twice.status).toBe(409);
    expect(await errorCodeOf(twice)).toBe('conflict');
    expect(await logsOf(target, epic.id)).toHaveLength(1);
    expect((await call(epicUncancel, target, epic.id)).status).toBe(200);
    expect((await call(epicUncancel, target, epic.id)).status).toBe(409);
    expect(await logsOf(target, epic.id)).toHaveLength(2);
  });

  test.each([epicCancel, epicUncancel])(
    '$name は他組織・別ワークスペース・削除済み・存在しないIDに404を返す',
    async (definition) => {
      const target = await createTarget();
      const other = await createTarget();
      const foreign = await epicOf(other, { canceled_at: definition === epicUncancel ? AT : null });
      const deleted = await epicOf(target, { deleted_at: AT });
      const workspace = await createWorkspace(target.organization, target.admin.userId!);
      const elsewhere = await createEpic(target.organization, workspace.id, target.admin.userId!, {
        canceled_at: definition === epicUncancel ? AT : null,
      });
      for (const id of [foreign.id, elsewhere.id, deleted.id, '0198a3b4-0000-7000-8000-000000000000']) {
        expect((await call(definition, target, id)).status).toBe(404);
      }
      expect(await logsOf(other, foreign.id)).toEqual([]);
    },
  );

  test.each([epicCancel, epicUncancel])('$name は閉じたワークスペースに書き込まない', async (definition) => {
    const target = await createTarget({ closed: true });
    const epic = await epicOf(target, { canceled_at: definition === epicUncancel ? AT : null });
    const before = await rowOf(target, epic.id);
    const res = await call(definition, target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await rowOf(target, epic.id)).toEqual(before);
    expect(await logsOf(target, epic.id)).toEqual([]);
  });

  test('中止と取り消しは配下の完了・討伐隊・確定済みの経験値を変えない', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
      completed_at: AT,
      completed_by: target.admin.userId!,
    });
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      story_id: story.id,
    });
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    await createXpGrant(target.organization, target.workspace.id, target.member.userId!, { task_id: task.id });
    await createXpGrant(target.organization, target.workspace.id, target.member.userId!, {
      action: 'story_completed',
      story_id: story.id,
      amount: 30,
    });
    const beforeXp = await xpOf(target);
    for (const definition of [epicCancel, epicUncancel]) {
      expect((await call(definition, target, epic.id)).status).toBe(200);
      expect(await xpOf(target)).toEqual(beforeXp);
      const db = orgDb(env, target.organization.verified);
      expect(
        await db.first(
          db.statement((q) =>
            q
              .selectFrom('stories')
              .selectAll()
              .where('workspace_id', '=', target.workspace.id)
              .where('id', '=', story.id),
          ),
        ),
      ).toEqual(story);
      const party = await db.rows(
        db.statement((q) => q.selectFrom('epic_party_members').select('user_id').where('epic_id', '=', epic.id)),
      );
      expect(party).toEqual([{ user_id: target.member.userId }]);
    }
  });

  test('中止中は受注・割り振り・報酬・クリア・配下の完了と取り消しを拒み、中止を戻すとまた操作できる', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    const open = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
    });
    const done = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
      completed_at: AT,
      completed_by: target.admin.userId!,
      position: 'a1',
    });
    expect((await call(epicCancel, target, epic.id)).status).toBe(200);
    const actions = [
      () => call(epicPartyJoin, target, epic.id, target.member),
      () => call(epicPartyAssign, target, epic.id, target.leader, testEnv, { user_id: target.leader.userId }),
      () => call(epicRewardUpdate, target, epic.id, target.leader, testEnv, { reward_tier: 'large' }),
      () => call(epicComplete, target, epic.id),
      () => call(storyComplete, target, epic.id, target.leader, testEnv, { story_id: open.id }),
      () => call(storyReopen, target, epic.id, target.leader, testEnv, { story_id: done.id }),
    ];
    for (const action of actions) expect((await action()).status).toBe(409);
    expect((await call(epicUncancel, target, epic.id)).status).toBe(200);
    for (const action of actions) {
      // クリアは配下の未完了を残しているので、最後にまとめて行う。
      if (action === actions[3]) continue;
      expect((await action()).status).toBe(200);
    }
    expect((await call(storyComplete, target, epic.id, target.leader, testEnv, { story_id: done.id })).status).toBe(
      200,
    );
    expect((await call(epicComplete, target, epic.id)).status).toBe(200);
  });

  test.each(['cancel-first', 'clear-first'] as const)('%s: 同時の中止とクリアは片方だけが通る', async (order) => {
    const target = await createTarget();
    const epic = await epicOf(target);
    await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      epic_id: epic.id,
      completed_at: AT,
      completed_by: target.admin.userId!,
    });
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    const first = order === 'cancel-first' ? epicCancel : epicComplete;
    const second = order === 'cancel-first' ? epicComplete : epicCancel;
    let winner: Response | undefined;
    const loser = await call(
      second,
      target,
      epic.id,
      target.leader,
      racing(async () => {
        winner = await call(first, target, epic.id, target.admin);
      }),
    );
    expect(winner?.status).toBe(200);
    expect(loser.status).toBe(409);
    const row = await rowOf(target, epic.id);
    expect(row.canceled_at !== null).toBe(order === 'cancel-first');
    expect(row.completed_at !== null).toBe(order === 'clear-first');
    expect(await logsOf(target, epic.id)).toHaveLength(1);
    expect(await xpOf(target)).toHaveLength(order === 'clear-first' ? 1 : 0);
  });

  test.each([epicCancel, epicUncancel])(
    '$name は読み取り後にワークスペースが閉じたら何も書かない',
    async (definition) => {
      const target = await createTarget();
      const epic = await epicOf(target, {
        canceled_at: definition === epicUncancel ? AT : null,
        canceled_by: definition === epicUncancel ? target.admin.userId! : null,
      });
      const before = await rowOf(target, epic.id);
      const raced = racing(async () => {
        const db = orgDb(env, target.organization.verified);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('workspaces')
              .set({ closed_at: AT })
              .where('id', '=', target.workspace.id)
              .where('organization_id', '=', target.organization.id),
          ),
        );
      });
      const res = await call(definition, target, epic.id, target.leader, raced);
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('workspace_closed');
      expect(await rowOf(target, epic.id)).toEqual(before);
      expect(await logsOf(target, epic.id)).toEqual([]);
    },
  );

  test.each([epicCancel, epicUncancel])(
    '$name は読み取り後に依頼主が替わったら403で何も書かない',
    async (definition) => {
      const target = await createTarget();
      const epic = await epicOf(target, {
        requester_user_id: target.member.userId!,
        canceled_at: definition === epicUncancel ? AT : null,
        canceled_by: definition === epicUncancel ? target.admin.userId! : null,
      });
      const raced = racing(async () => {
        const db = orgDb(env, target.organization.verified);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('epics')
              .set({ requester_user_id: target.admin.userId! })
              .where('id', '=', epic.id)
              .where('workspace_id', '=', target.workspace.id),
          ),
        );
      });
      const res = await call(definition, target, epic.id, target.member, raced);
      expect(res.status).toBe(403);
      expect((await rowOf(target, epic.id)).canceled_at).toBe(epic.canceled_at);
      expect(await logsOf(target, epic.id)).toEqual([]);
    },
  );

  test.each([epicCancel, epicUncancel])('$name の同時実行は一度だけ履歴を書く', async (definition) => {
    const target = await createTarget();
    const epic = await epicOf(target, {
      canceled_at: definition === epicUncancel ? AT : null,
      canceled_by: definition === epicUncancel ? target.admin.userId! : null,
    });
    let winner: Response | undefined;
    const loser = await call(
      definition,
      target,
      epic.id,
      target.leader,
      racing(async () => {
        winner = await call(definition, target, epic.id, target.admin);
      }),
    );
    expect(winner?.status).toBe(200);
    expect(loser.status).toBe(409);
    expect(await logsOf(target, epic.id)).toHaveLength(1);
  });
});
