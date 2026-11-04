// エピックのクリアと取り消し（epic-complete、epic-reopen）の振る舞い（クリア報酬の付与と打ち消し、競合、変更の履歴）。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { XP_EPIC_REWARD } from '../src/shared/experience.ts';
import { epicComplete, epicReopen } from '../src/shared/operations/epic/index.ts';
import { storyMove } from '../src/shared/operations/story/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createEpic, createEpicPartyMember, createMembership, createStory, createUser } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

// 開発用の時計（DEV_NOW）で時刻を止めた、ループバックの公開 URL の環境
function clockAt(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function clear(target: Target, epicId: string, person: Person = target.leader, requestEnv: Env = testEnv) {
  return post(app, epicComplete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId },
    env: requestEnv,
  });
}

function reopen(target: Target, epicId: string, person: Person = target.leader, requestEnv: Env = testEnv) {
  return post(app, epicReopen, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, epic_id: epicId },
    env: requestEnv,
  });
}

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

// 読んでから書くまでに別の要求が割り込んだ状況を作る。match に当たる batch() が答えた直後に、一度だけ change を流す
function racing(match: (sqls: readonly string[]) => boolean, change: () => Promise<void>): Env {
  let done = false;
  return envWithD1Hooks(testEnv, {
    afterBatch: async (sqls) => {
      if (done || !match(sqls)) return;
      done = true;
      await change();
    },
  });
}

// クリアする前の状態の読み取り（エピック、配下の件数、受け取り手）
const readsEpic = (sqls: readonly string[]) => sqls[0]?.startsWith('select "epics"."reward_tier"') === true;

function epicOf(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  return createEpic(target.organization, target.workspace.id, target.admin.userId!, overrides);
}

// 配下のストーリー。既定は完了済み
function storyUnder(target: Target, epicId: string, overrides: Parameters<typeof createStory>[3] = {}) {
  return createStory(target.organization, target.workspace.id, target.admin.userId!, {
    epic_id: epicId,
    completed_at: AT,
    completed_by: target.admin.userId!,
    ...overrides,
  });
}

async function epicRow(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return (await db.first(
    db.statement((q) =>
      q.selectFrom('epics').selectAll().where('id', '=', epicId).where('workspace_id', '=', target.workspace.id),
    ),
  ))!;
}

async function rewardGrants(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants')
        .selectAll()
        .where('epic_id', '=', epicId)
        .where('workspace_id', '=', target.workspace.id)
        .orderBy('id'),
    ),
  );
}

async function balances(target: Target, epicId: string) {
  const totals: Record<string, number> = {};
  for (const grant of await rewardGrants(target, epicId)) {
    totals[grant.user_id] = (totals[grant.user_id] ?? 0) + grant.amount;
  }
  return totals;
}

async function logsOf(target: Target, epicId: string) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'epic')
        .where('entity_id', '=', epicId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({
    actor: row.actor_user_id,
    action: row.action,
    changes: JSON.parse(row.changes_json) as unknown,
  }));
}

// 討伐隊が2人（メンバーとリーダー）で、配下が完了したストーリー1件のエピック
async function readyEpic(target: Target, overrides: Parameters<typeof createEpic>[3] = {}) {
  const epic = await epicOf(target, { reward_tier: 'medium', ...overrides });
  await storyUnder(target, epic.id);
  await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
  await createEpicPartyMember(target.organization, epic.id, target.leader.userId!);
  return epic;
}

describe('epic-complete', () => {
  test('今所属している討伐隊の全員に、段階の額を1行ずつ付け、変更の履歴を残す', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    // 抜けた人には付けない
    const leaver = await createUser(target.organization);
    await createMembership(target.organization, target.workspace.id, leaver.id, { left_on: '2026-10-10', left_at: AT });
    await createEpicPartyMember(target.organization, epic.id, leaver.id);

    const res = await clear(target, epic.id, target.leader);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      epic_id: string;
      completed_at: string;
      reward_xp: number;
      recipient_count: number;
    };
    expect(body).toMatchObject({ epic_id: epic.id, reward_xp: XP_EPIC_REWARD.medium, recipient_count: 2 });

    const row = await epicRow(target, epic.id);
    expect(row.completed_at).toBe(body.completed_at);
    expect(row.completed_by).toBe(target.leader.userId);
    const grants = await rewardGrants(target, epic.id);
    expect(grants.map((g) => [g.user_id, g.action, g.amount, g.reverses_grant_id, g.confirmed_at]).sort()).toEqual(
      [
        [target.member.userId, 'epic_reward', 300, null, body.completed_at],
        [target.leader.userId, 'epic_reward', 300, null, body.completed_at],
      ].sort(),
    );
    expect(
      grants.every((g) => g.dedupe_key.startsWith(`epic_reward:${epic.id}:${g.user_id}:${body.completed_at}:`)),
    ).toBe(true);
    const logs = await logsOf(target, epic.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: target.leader.userId, action: 'complete' });
  });

  test('依頼主は一般のメンバーでもクリアできる。依頼主でもリーダーでもないメンバーは 403 で、何も書かない', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target, { requester_user_id: target.leader.userId! });
    const denied = await clear(target, epic.id, target.member);
    expect(denied.status).toBe(403);
    expect((await epicRow(target, epic.id)).completed_at).toBeNull();
    expect(await rewardGrants(target, epic.id)).toEqual([]);
    expect(await logsOf(target, epic.id)).toEqual([]);

    const own = await readyEpic(target, { requester_user_id: target.member.userId! });
    expect((await clear(target, own.id, target.member)).status).toBe(200);
  });

  test('討伐隊が0人でもクリアでき、報酬は誰にも付かない', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    await storyUnder(target, epic.id);
    const res = await clear(target, epic.id);
    expect(res.status).toBe(200);
    expect(await rewardGrants(target, epic.id)).toEqual([]);
  });

  test('未完了のストーリーが残っていれば 409 の conflict（open_stories）、削除したストーリーは数えない', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const open = await storyUnder(target, epic.id, { completed_at: null, completed_by: null });
    const res = await clear(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_stories' });
    expect((await epicRow(target, epic.id)).completed_at).toBeNull();
    expect(await rewardGrants(target, epic.id)).toEqual([]);
    expect(await logsOf(target, epic.id)).toEqual([]);

    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ deleted_at: AT })
          .where('id', '=', open.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect((await clear(target, epic.id)).status).toBe(200);
  });

  test('配下に削除していないストーリーが1件も無ければ 409 の conflict（empty）', async () => {
    const target = await createTarget();
    const epic = await epicOf(target);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    const res = await clear(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'empty' });
    expect(await rewardGrants(target, epic.id)).toEqual([]);
  });

  test('中止したエピックは 409 の epic_finished、すでにクリアしていれば 409 の conflict（completed）', async () => {
    const target = await createTarget();
    const canceled = await readyEpic(target, { canceled_at: AT, canceled_by: target.admin.userId! });
    const res = await clear(target, canceled.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'epic_finished', reason: undefined });

    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    const again = await clear(target, epic.id);
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toEqual({ code: 'conflict', reason: 'completed' });
    expect(await rewardGrants(target, epic.id)).toHaveLength(2);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const epic = await readyEpic(target);
    const res = await clear(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'workspace_closed', reason: undefined });
    expect((await epicRow(target, epic.id)).completed_at).toBeNull();
    expect(await rewardGrants(target, epic.id)).toEqual([]);
  });

  test('別の組織・別のワークスペースのエピックと存在しない ID は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await readyEpic(other);
    expect((await clear(target, foreign.id)).status).toBe(404);
    expect((await clear(target, '0198a3b4-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await epicRow(other, foreign.id)).completed_at).toBeNull();
  });

  test('止めた時計で同時に2回クリアしても、記録と報酬は1人1行', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    const results = await Promise.all([
      clear(target, epic.id, target.leader, frozen),
      clear(target, epic.id, target.leader, frozen),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await rewardGrants(target, epic.id)).toHaveLength(2);
    expect(await logsOf(target, epic.id)).toHaveLength(1);
  });

  test('2つの画面から同時にクリアすると、片方は 409 の conflict（completed）で、報酬は1人1行', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    let second: Response | undefined;
    const raced = racing(readsEpic, async () => {
      second = await clear(target, epic.id, target.admin);
    });
    const first = await clear(target, epic.id, target.leader, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'completed' });
    expect((await epicRow(target, epic.id)).completed_by).toBe(target.admin.userId);
    expect(await rewardGrants(target, epic.id)).toHaveLength(2);
    expect(await logsOf(target, epic.id)).toHaveLength(1);
  });

  test('読んでから書くまでに討伐隊が増えたら、読み直してやり直し、増えた人にも付ける', async () => {
    const target = await createTarget();
    const epic = await epicOf(target, { reward_tier: 'small' });
    await storyUnder(target, epic.id);
    await createEpicPartyMember(target.organization, epic.id, target.member.userId!);
    const raced = racing(readsEpic, async () => {
      await createEpicPartyMember(target.organization, epic.id, target.leader.userId!);
    });
    const res = await clear(target, epic.id, target.leader, raced);
    expect(res.status).toBe(200);
    expect(await balances(target, epic.id)).toEqual({
      [target.member.userId!]: XP_EPIC_REWARD.small,
      [target.leader.userId!]: XP_EPIC_REWARD.small,
    });
    expect(await logsOf(target, epic.id)).toHaveLength(1);
  });

  test('読んでから書くまでに未完了のストーリーが足されたら、何も書かず 409 の conflict（open_stories）', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const raced = racing(readsEpic, async () => {
      await storyUnder(target, epic.id, { completed_at: null, completed_by: null });
    });
    const res = await clear(target, epic.id, target.leader, raced);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'open_stories' });
    expect(await rewardGrants(target, epic.id)).toEqual([]);
    expect(await logsOf(target, epic.id)).toEqual([]);
  });

  test('クリアしたエピックからも、ストーリーを移し出せない（同じストーリーで別のエピックをもう一度クリアできてしまうため）', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const story = await storyUnder(target, epic.id, { position: 'a1' });
    expect((await clear(target, epic.id)).status).toBe(200);
    const other = await epicOf(target);
    for (const destination of [other.id, null]) {
      const res = await post(app, storyMove, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, story_id: story.id, epic_id: destination },
        env: testEnv,
      });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({ code: 'conflict', reason: 'parent_completed' });
    }
  });

  test('クリアしたエピックの下へは、ストーリーを移せない', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    const loose = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    const res = await post(app, storyMove, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, story_id: loose.id, epic_id: epic.id },
      env: testEnv,
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: 'conflict', reason: 'parent_completed' });
  });
});

describe('epic-reopen', () => {
  test('クリアを取り消し、その回の報酬をすべて打ち消し、もう一度クリアすると付け直す', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    const firstRow = await epicRow(target, epic.id);

    const res = await reopen(target, epic.id, target.leader);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epic_id: epic.id });
    const reopened = await epicRow(target, epic.id);
    expect(reopened.completed_at).toBeNull();
    expect(reopened.completed_by).toBeNull();
    const grants = await rewardGrants(target, epic.id);
    expect(grants).toHaveLength(4);
    const reversals = grants.filter((g) => g.reverses_grant_id !== null);
    expect(reversals.map((g) => [g.action, g.amount])).toEqual([
      ['epic_reward', -300],
      ['epic_reward', -300],
    ]);
    expect(reversals.every((g) => g.dedupe_key === `reversal:${g.reverses_grant_id}`)).toBe(true);
    expect(await balances(target, epic.id)).toEqual({ [target.member.userId!]: 0, [target.leader.userId!]: 0 });

    // もう一度クリアすると、新しい回の報酬が付く
    expect((await clear(target, epic.id)).status).toBe(200);
    expect((await epicRow(target, epic.id)).completed_at).not.toBe(firstRow.completed_at);
    expect(await balances(target, epic.id)).toEqual({ [target.member.userId!]: 300, [target.leader.userId!]: 300 });

    const actions = (await logsOf(target, epic.id)).map((log) => log.action);
    expect(actions).toEqual(['complete', 'reopen', 'complete']);
    expect((await logsOf(target, epic.id))[1]!.changes).toEqual({
      completed_at: [firstRow.completed_at, null],
      completed_by: [{ id: target.leader.userId, name: expect.any(String) }, null],
    });
  });

  test('止めた時計で、クリア、取り消し、クリアを同じ時刻に流しても落ちず、2回目のクリアで報酬を付け直す', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const frozen = clockAt('2026-10-26T01:00:00.000Z');
    expect((await clear(target, epic.id, target.leader, frozen)).status).toBe(200);
    expect((await reopen(target, epic.id, target.leader, frozen)).status).toBe(200);
    const again = await clear(target, epic.id, target.leader, frozen);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ recipient_count: 2 });
    expect((await epicRow(target, epic.id)).completed_at).toBe('2026-10-26T01:00:00.000Z');
    // 付与2行、打ち消し2行、付け直し2行。合計は 300 ずつ
    expect(await rewardGrants(target, epic.id)).toHaveLength(6);
    expect(await balances(target, epic.id)).toEqual({ [target.member.userId!]: 300, [target.leader.userId!]: 300 });
  });

  test('クリアと取り消しを2回ずつ流しても、合計は 0 で、打ち消しは元の付与を1回ずつだけ指す', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    for (let round = 0; round < 2; round++) {
      expect((await clear(target, epic.id)).status).toBe(200);
      expect((await reopen(target, epic.id)).status).toBe(200);
    }
    const grants = await rewardGrants(target, epic.id);
    expect(grants).toHaveLength(8);
    expect(await balances(target, epic.id)).toEqual({ [target.member.userId!]: 0, [target.leader.userId!]: 0 });
    const reversed = grants.filter((g) => g.reverses_grant_id !== null).map((g) => g.reverses_grant_id);
    expect(new Set(reversed).size).toBe(4);
  });

  test('読んでから書くまでに受け取り手が所属を外れたら、その人には付けず、応答の人数も付いた数にする', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    const raced = racing(readsEpic, async () => {
      const db = orgDb(env, target.organization.verified);
      await db.run(
        db.statement((q) =>
          q
            .updateTable('memberships')
            .set({ left_on: '2026-10-30', left_at: AT })
            .where('workspace_id', '=', target.workspace.id)
            .where('user_id', '=', target.member.userId!),
        ),
      );
    });
    const res = await clear(target, epic.id, target.leader, raced);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recipient_count: 1 });
    expect(await balances(target, epic.id)).toEqual({ [target.leader.userId!]: 300 });
  });

  test('受け取った人が所属を外れていても、取り消すと打ち消す', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_on: '2026-10-30', left_at: AT })
          .where('workspace_id', '=', target.workspace.id)
          .where('user_id', '=', target.member.userId!),
      ),
    );
    expect((await reopen(target, epic.id)).status).toBe(200);
    expect(await balances(target, epic.id)).toEqual({ [target.member.userId!]: 0, [target.leader.userId!]: 0 });
  });

  test('クリアしていなければ 409 の conflict（not_completed）、中止したエピックは 409 の epic_finished', async () => {
    const target = await createTarget();
    const open = await readyEpic(target);
    const res = await reopen(target, open.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'conflict', reason: 'not_completed' });
    const canceled = await readyEpic(target, { canceled_at: AT, canceled_by: target.admin.userId! });
    expect(await errorOf(await reopen(target, canceled.id))).toEqual({ code: 'epic_finished', reason: undefined });
  });

  test('依頼主かリーダーでなければ 403 で、何も書かない。依頼主は取り消せる', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target, { requester_user_id: target.leader.userId! });
    expect((await clear(target, epic.id)).status).toBe(200);
    expect((await reopen(target, epic.id, target.member)).status).toBe(403);
    expect((await epicRow(target, epic.id)).completed_at).not.toBeNull();
    expect(await rewardGrants(target, epic.id)).toHaveLength(2);

    const own = await readyEpic(target, { requester_user_id: target.member.userId! });
    expect((await clear(target, own.id, target.member)).status).toBe(200);
    expect((await reopen(target, own.id, target.member)).status).toBe(200);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const epic = await readyEpic(target, { completed_at: AT, completed_by: target.admin.userId! });
    const res = await reopen(target, epic.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'workspace_closed', reason: undefined });
    expect((await epicRow(target, epic.id)).completed_at).toBe(AT);
  });

  test('2つの画面から同時に取り消すと、片方は 409 の conflict（not_completed）で、打ち消しは1回分', async () => {
    const target = await createTarget();
    const epic = await readyEpic(target);
    expect((await clear(target, epic.id)).status).toBe(200);
    let second: Response | undefined;
    const raced = racing(readsEpic, async () => {
      second = await reopen(target, epic.id, target.admin);
    });
    const first = await reopen(target, epic.id, target.leader, raced);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(await errorOf(first)).toEqual({ code: 'conflict', reason: 'not_completed' });
    expect((await rewardGrants(target, epic.id)).filter((g) => g.reverses_grant_id !== null)).toHaveLength(2);
  });

  test('別の組織のエピックと存在しない ID は 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await readyEpic(other, { completed_at: AT, completed_by: other.admin.userId! });
    expect((await reopen(target, foreign.id)).status).toBe(404);
    expect((await reopen(target, '0198a3b4-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await epicRow(other, foreign.id)).completed_at).toBe(AT);
  });
});
