import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { onboardingWorkspacePrepare } from '../src/shared/operations/workspace/onboarding-workspace-prepare.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/index.ts';
import { createMembership, createOrganization, createWorkspace } from './factories.ts';
import { afterFirstQuery } from './auth/helpers.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson } from './operations/world.ts';

const app = createApp(implementedOperations);
const input = { timezone: 'Asia/Tokyo' };

async function team() {
  const organization = await createOrganization();
  const admin = await createPerson({ organization, admin: true });
  return { organization, admin };
}
type Team = Awaited<ReturnType<typeof team>>;
const prepare = ({ organization, admin }: Team, testEnv?: Env) =>
  post(app, onboardingWorkspacePrepare, { slug: organization.slug, token: admin.token, body: input, env: testEnv });
async function workspaces({ organization }: Team) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('workspaces').select(['id', 'name', 'closed_at']).where('organization_id', '=', organization.id),
    ),
  );
}

describe('チーム導入のワークスペース準備', () => {
  test('導入準備の INSERT SELECT も vocabulary を指定せず、既定の game でも初期の名前はスクラムになる', async () => {
    const target = await team();
    const writes: string[] = [];
    const response = await prepare(target, envWithD1Hooks(env, { beforeBatch: (sqls) => void writes.push(...sqls) }));
    expect(response.status).toBe(200);
    const inserts = writes.filter((sql) => sql.startsWith('insert into "workspaces"'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toMatch(/vocabulary/i);
    const result = (await response.json()) as { workspace_id: string };
    expect(result).toEqual({ workspace_id: expect.any(String) });
    const db = orgDb(env, target.organization.verified);
    const workspace = await db.first(
      db.statement((q) =>
        q
          .selectFrom('workspaces')
          .select('vocabulary')
          .where('organization_id', '=', target.organization.id)
          .where('id', '=', result.workspace_id),
      ),
    );
    expect(workspace).toEqual({ vocabulary: 'game' });
    const columns = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('board_columns')
          .select('name')
          .where('workspace_id', '=', result.workspace_id)
          .orderBy('position'),
      ),
    );
    expect(columns.map((column) => column.name)).toEqual(['未着手', '作業中', 'レビュー', null]);
    const fields = await db.rows(
      db.statement((q) => q.selectFrom('detail_fields').select('name').where('workspace_id', '=', result.workspace_id)),
    );
    expect(fields).toEqual([{ name: '受け入れ基準' }]);
  });

  test('2並行要求と再送は同じIDに収束し、ワークスペースと初期行は1組だけになる', async () => {
    const target = await team();
    const responses = await Promise.all([prepare(target), prepare(target)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(
      responses.map(async (response) => (await response.json()) as { workspace_id: string }),
    );
    expect(first).toEqual(second);
    expect(await workspaces(target)).toEqual([{ id: first!.workspace_id, name: 'チームのタスク', closed_at: null }]);
    expect(await (await prepare(target)).json()).toEqual(first);
    const db = orgDb(env, target.organization.verified);
    const members = await db.rows(
      db.statement((q) =>
        q.selectFrom('memberships').select(['user_id', 'role']).where('workspace_id', '=', first!.workspace_id),
      ),
    );
    const columns = await db.rows(
      db.statement((q) => q.selectFrom('board_columns').select('id').where('workspace_id', '=', first!.workspace_id)),
    );
    expect(members).toEqual([{ user_id: target.admin.userId, role: 'leader' }]);
    expect(columns).toHaveLength(4);
  });

  test('未作成と読んだ直後に別要求が作っても、書く条件で二重作成を止めて同じIDを返す', async () => {
    const target = await team();
    let winner: { workspace_id: string } | undefined;
    const racing = afterFirstQuery(
      env,
      (sql) => sql.includes('from "workspaces" as "w"') && sql.includes('inner join "memberships"'),
      async () => {
        const response = await prepare(target);
        expect(response.status).toBe(200);
        winner = (await response.json()) as { workspace_id: string };
      },
    );
    const response = await prepare(target, racing);
    expect(response.status).toBe(200);
    expect(winner).toBeDefined();
    expect(await response.json()).toEqual(winner);
    expect(await workspaces(target)).toHaveLength(1);
  });

  test('D1の書込後に応答だけ失っても、再読と再送で同じ1件を返す', async () => {
    const target = await team();
    let lost = false;
    const losing = envWithD1Hooks(env, {
      afterBatch: (sqls) => {
        if (!lost && sqls.some((sql) => sql.startsWith('insert into "workspaces"'))) {
          lost = true;
          throw new Error('simulated lost workspace write response');
        }
      },
    });
    const response = await prepare(target, losing);
    expect(lost).toBe(true);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(await (await prepare(target)).json()).toEqual(result);
    expect(await workspaces(target)).toHaveLength(1);
  });

  test('開いた自分のリーダー所属を再利用し、新しい行を足さない', async () => {
    const target = await team();
    const workspace = await createWorkspace(target.organization, target.admin.userId!);
    await createMembership(target.organization, workspace.id, target.admin.userId!, { role: 'leader' });
    const response = await prepare(target);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace_id: workspace.id });
    expect(await workspaces(target)).toHaveLength(1);
  });

  test.each(['closed', 'member', 'none'] as const)('既存が%sのみなら409で断り、作り足さない', async (state) => {
    const target = await team();
    const workspace = await createWorkspace(
      target.organization,
      target.admin.userId!,
      state === 'closed' ? { closed_at: '2026-11-01T00:00:00.000Z' } : {},
    );
    if (state !== 'none')
      await createMembership(target.organization, workspace.id, target.admin.userId!, {
        role: state === 'member' ? 'member' : 'leader',
      });
    const response = await prepare(target);
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('conflict');
    expect(await workspaces(target)).toHaveLength(1);
  });

  test('閉じた所属を飛ばして開いたリーダー所属を使う', async () => {
    const target = await team();
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      name: 'あ',
      closed_at: '2026-11-01T00:00:00.000Z',
    });
    const open = await createWorkspace(target.organization, target.admin.userId!, { name: 'い' });
    for (const workspace of [closed, open])
      await createMembership(target.organization, workspace.id, target.admin.userId!, { role: 'leader' });
    expect(await (await prepare(target)).json()).toEqual({ workspace_id: open.id });
    expect(await workspaces(target)).toHaveLength(2);
  });

  test('自分用の組織では作らない', async () => {
    const target = await team();
    // 組織の種類だけを替え、管理者やログインの条件は同じにする。
    const { commonDb } = await import('../src/server/db/index.ts');
    const db = commonDb(env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ kind: 'personal', created_by_account_id: target.admin.accountId })
          .where('id', '=', target.organization.id),
      ),
    ]);
    const response = await prepare(target);
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('conflict');
    expect(await workspaces(target)).toEqual([]);
  });

  test('通常のワークスペース作成は引き続き複数作れる', async () => {
    const target = await team();
    expect((await prepare(target)).status).toBe(200);
    const response = await post(app, workspaceCreate, {
      slug: target.organization.slug,
      token: target.admin.token,
      body: { ...input, name: '追加のチーム', leader_user_id: target.admin.userId },
    });
    expect(response.status).toBe(200);
    expect(await workspaces(target)).toHaveLength(2);
  });
});
