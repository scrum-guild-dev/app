// #267: 離脱・無効化の本体が通ったときだけ、全状態のエピックから外し履歴を残す。
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test } from 'vitest';
import { setFixedNow } from '../src/shared/clock.ts';
import { userDisable } from '../src/shared/operations/organization/index.ts';
import { membershipLeave } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { membershipLeaveOperation } from '../src/server/operations/membership.ts';
import { userDisableOperation } from '../src/server/operations/user.ts';
import { createEpic, createEpicPartyMember, createMembership, createXpGrant } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const STAMP = '2026-11-14T10:00:00.000Z';
const dbOf = (target: Target) => orgDb(env, target.organization.verified);
afterEach(() => setFixedNow(undefined));

async function partyRows(target: Target) {
  const db = dbOf(target);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('epic_party_members as p')
        .innerJoin('epics as e', 'e.id', 'p.epic_id')
        .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
        .selectAll('p')
        .where('w.organization_id', '=', db.organizationId),
    ),
  );
}
async function partyLogs(target: Target) {
  const db = dbOf(target);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', db.organizationId)
        .where('entity_type', '=', 'epic'),
    ),
  );
}
async function fixture() {
  const target = await createTarget();
  const userId = target.member.userId!;
  const states = [{}, { completed_at: STAMP }, { canceled_at: STAMP }, { deleted_at: STAMP }];
  const epics = [];
  for (const [index, state] of states.entries()) {
    const epic = await createEpic(target.organization, target.workspace.id, userId, state);
    await createEpicPartyMember(target.organization, epic.id, userId, {
      joined_via: (['self', 'assigned', 'task_assignee', 'self'] as const)[index],
    });
    await createEpicPartyMember(target.organization, epic.id, target.leader.userId!);
    epics.push(epic);
  }
  await createMembership(target.organization, target.otherWorkspace.id, userId);
  const other = await createEpic(target.organization, target.otherWorkspace.id, userId);
  await createEpicPartyMember(target.organization, other.id, userId);
  const grant = await createXpGrant(target.organization, target.workspace.id, userId, {
    epic_id: epics[1]!.id,
    action: 'epic_reward',
    amount: 100,
  });
  return { target, userId, epics, other, grant };
}

describe('討伐隊の離脱と無効化', () => {
  for (const mode of ['leader', 'self', 'disable'] as const) {
    test(`${mode}: 全状態から外れ、別の人・依頼主・報酬を保ち、ワークスペースを絞る`, async () => {
      const { target, userId, epics, other, grant } = await fixture();
      const db = dbOf(target);
      // 無効化は閉じたワークスペースの討伐隊も外す。
      if (mode === 'disable')
        await db.run(
          db.statement((q) =>
            q
              .updateTable('workspaces')
              .set({ closed_at: STAMP })
              .where('id', '=', target.otherWorkspace.id)
              .where('organization_id', '=', db.organizationId),
          ),
        );
      const caller = mode === 'self' ? target.member : mode === 'leader' ? target.leader : target.admin;
      const response =
        mode === 'disable'
          ? await post(app, userDisable, { slug: target.slug, token: caller.token, body: { user_id: userId } })
          : await post(app, membershipLeave, {
              slug: target.slug,
              token: caller.token,
              body: { workspace_id: target.workspace.id, user_id: userId },
            });
      expect(response.status).toBe(200);
      const rows = await partyRows(target);
      expect(rows.filter((row) => row.user_id === target.leader.userId)).toHaveLength(4);
      expect(rows.filter((row) => row.user_id === userId).map((row) => row.epic_id)).toEqual(
        mode === 'disable' ? [] : [other.id],
      );
      const expected = mode === 'disable' ? [...epics, other] : epics;
      const logs = await partyLogs(target);
      expect(logs).toHaveLength(expected.length);
      expect(new Set(logs.map((log) => log.id)).size).toBe(expected.length);
      const user = await db.first(
        db.statement((q) =>
          q
            .selectFrom('users')
            .select('name')
            .where('id', '=', userId)
            .where('organization_id', '=', db.organizationId),
        ),
      );
      for (const epic of expected) {
        const log = logs.find((row) => row.entity_id === epic.id)!;
        expect(log).toMatchObject({ workspace_id: epic.workspace_id, actor_user_id: caller.userId, action: 'update' });
        expect(JSON.parse(log.changes_json)).toEqual({
          party_member: [
            {
              id: userId,
              name: user!.name,
              via: (['self', 'assigned', 'task_assignee', 'self'] as const)[epics.indexOf(epic)] ?? 'self',
            },
            null,
          ],
        });
      }
      const afterEpics = await db.rows(
        db.statement((q) => q.selectFrom('epics').selectAll().where('workspace_id', '=', target.workspace.id)),
      );
      expect(afterEpics.every((epic) => epic.requester_user_id === userId)).toBe(true);
      expect(
        await db.first(db.statement((q) => q.selectFrom('xp_grants').selectAll().where('id', '=', grant.id))),
      ).toEqual(grant);
    });
  }

  test('別の組織の討伐隊と履歴を変えない', async () => {
    const { target, userId } = await fixture();
    const foreign = await fixture();
    const before = await partyRows(foreign.target);
    expect(
      (await post(app, userDisable, { slug: target.slug, token: target.admin.token, body: { user_id: userId } }))
        .status,
    ).toBe(200);
    expect(await partyRows(foreign.target)).toEqual(before);
    expect(await partyLogs(foreign.target)).toEqual([]);
  });

  for (const mode of ['leave', 'disable'] as const) {
    for (const sameTimestamp of [false, true]) {
      test(`${mode}: 競合で本体が書けないなら討伐隊も履歴も変えない（同時刻=${sameTimestamp}）`, async () => {
        const { target, userId } = await fixture();
        const db = dbOf(target);
        const caller = mode === 'leave' ? target.leader : target.admin;
        const actor = {
          accountId: caller.accountId,
          userId: caller.userId,
          isAdmin: mode === 'disable',
          invitedOnly: false,
        };
        const workspace = await verifyWorkspace(db, actor, target.workspace.id);
        const before = await partyRows(target);
        let raced = false;
        const racing = new Proxy(db, {
          get(base, key) {
            const value = Reflect.get(base, key, base);
            if (typeof value !== 'function') return value;
            if (key !== 'batch') return value.bind(base);
            return async (...args: unknown[]) => {
              if (!raced) {
                raced = true;
                if (mode === 'leave') {
                  await db.run(
                    db.statement((q) =>
                      q
                        .updateTable('memberships')
                        .set(sameTimestamp ? { left_at: STAMP, left_on: '2026-11-14' } : { role: 'member' })
                        .where('workspace_id', '=', target.workspace.id)
                        .where('user_id', '=', sameTimestamp ? userId : caller.userId!),
                    ),
                  );
                } else {
                  await db.run(
                    db.statement((q) =>
                      q
                        .updateTable('users')
                        .set(sameTimestamp ? { disabled_at: STAMP } : { is_admin: 0 })
                        .where('id', '=', sameTimestamp ? userId : caller.userId!)
                        .where('organization_id', '=', db.organizationId),
                    ),
                  );
                }
              }
              return value.apply(base, args);
            };
          },
        });
        setFixedNow(new Date(STAMP));
        const context = {
          db: racing,
          actor,
          workspace,
          input: { user_id: userId, workspace_id: target.workspace.id },
          tools: {},
          defer: () => {},
        } as never;
        const run =
          mode === 'leave' ? membershipLeaveOperation.handler(context) : userDisableOperation.handler(context);
        if (mode === 'disable' && sameTimestamp) await expect(run).resolves.toMatchObject({ disabled_at: STAMP });
        else await expect(run).rejects.toMatchObject({ status: sameTimestamp ? 404 : 403 });
        expect(raced).toBe(true);
        expect(await partyRows(target)).toEqual(before);
        expect(await partyLogs(target)).toEqual([]);
      });
    }
  }
});
