import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiUpload, workspaceWikiUpload } from '../src/shared/operations/wiki/index.ts';
import { AT, createMembership, createUser, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const files = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ file_name: `架空の手順${index}.md`, body_md: '本文' }));

for (const kind of ['organization', 'workspace'] as const) {
  const organization = kind === 'organization';
  const definition = organization ? orgWikiUpload : workspaceWikiUpload;
  function upload(target: Target, count = 2, extra: Record<string, unknown> = {}, requestEnv: Env = env) {
    return post(app, definition, {
      slug: target.slug,
      token: target.member.token,
      body: { ...(organization ? {} : { workspace_id: target.workspace.id }), files: files(count), ...extra },
      env: requestEnv,
    });
  }
  async function rows(target: Target) {
    const db = orgDb(env, target.organization.verified);
    const pages = await db.rows(
      db.statement((q) => {
        const query = q.selectFrom('wiki_pages').select(['id', 'parent_id']);
        return organization
          ? query.where('organization_id', '=', target.organization.id)
          : query.where('workspace_id', '=', target.workspace.id);
      }),
    );
    const revisions = await db.rows(
      db.statement((q) => {
        const query = q
          .selectFrom('wiki_page_revisions as r')
          .innerJoin('wiki_pages as p', 'p.id', 'r.page_id')
          .select('r.page_id');
        return organization
          ? query.where('p.organization_id', '=', target.organization.id)
          : query.where('p.workspace_id', '=', target.workspace.id);
      }),
    );
    return { pages, revisions };
  }
  async function count(target: Target) {
    const db = commonDb(env);
    return (
      await db.first(
        db.statement((q) =>
          q
            .selectFrom('rate_limits')
            .select('count')
            .where('key', '=', `operation:${definition.name}:${target.member.accountId}`),
        ),
      )
    )?.count;
  }
  async function seed(target: Target, parent: string | null = null) {
    const db = orgDb(env, target.organization.verified);
    const id = uuidv7();
    await db.batch([
      db.statement((q) =>
        q.insertInto('wiki_pages').values({
          id,
          organization_id: organization ? target.organization.id : null,
          workspace_id: organization ? null : target.workspace.id,
          parent_id: parent,
          position: 'a0',
          title: '架空の親',
          body_md: '本文',
          version: 1,
          created_by: target.member.userId!,
          updated_by: target.member.userId!,
          created_at: AT,
          updated_at: AT,
        }),
      ),
    ]);
    return id;
  }

  describe(`${kind}: 一括取り込みの追加の競合経路`, () => {
    test('20件ずつ同時に送っても30件の回数上限を超えて両方を保存しない', async () => {
      const target = await createTarget();
      const responses = await Promise.all([upload(target, 20), upload(target, 20)]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
      expect(await errorCodeOf(responses.find((response) => response.status === 429)!)).toBe('rate_limited');
      const stored = await rows(target);
      expect(stored.pages).toHaveLength(20);
      expect(stored.revisions).toHaveLength(20);
      expect(await count(target)).toBe(40);
    });

    test('検証後に親が深さ10段へ動くと、11段目になる全件をSQLで拒否する', async () => {
      const target = await createTarget();
      const parentId = await seed(target);
      let deepest: string | null = null;
      for (let depth = 0; depth < 9; depth++) deepest = await seed(target, deepest);
      const db = orgDb(env, target.organization.verified);
      let fired = false;
      const hooked = envWithD1Hooks(env, {
        afterQuery: async (sql) => {
          if (fired || !sql.includes('order by "position"')) return;
          fired = true;
          await db.batch([
            db.statement((q) => {
              const query = q.updateTable('wiki_pages').set({ parent_id: deepest }).where('id', '=', parentId);
              return organization
                ? query.where('organization_id', '=', target.organization.id)
                : query.where('workspace_id', '=', target.workspace.id);
            }),
          ]);
        },
      });
      const response = await upload(target, 2, { parent_id: parentId }, hooked);
      expect(fired).toBe(true);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'too_deep' } } });
      const stored = await rows(target);
      expect(stored.pages).toHaveLength(10);
      expect(stored.revisions).toHaveLength(0);
      expect(await count(target)).toBe(2);
    });

    test('同じアカウントが別の組織へ移っても操作の回数枠は増えない', async () => {
      const [own, other] = await Promise.all([createTarget(), createTarget()]);
      const user = await createUser(other.organization, {
        account_id: own.member.accountId,
        login_provider: own.member.login.provider,
        login_subject: own.member.login.subject,
      });
      await createMembership(other.organization, other.workspace.id, user.id);
      expect((await upload(own, 20)).status).toBe(200);
      const response = await post(app, definition, {
        slug: other.slug,
        token: own.member.token,
        body: { ...(organization ? {} : { workspace_id: other.workspace.id }), files: files(20) },
      });
      expect(response.status).toBe(429);
      expect(await errorCodeOf(response)).toBe('rate_limited');
      expect(await rows(other)).toEqual({ pages: [], revisions: [] });
      expect(await count(own)).toBe(40);
    });
  });
}

test('検証後にワークスペースが閉じたら、全件を拒否してworkspace_closedを返す', async () => {
  const target = await createTarget();
  const db = orgDb(env, target.organization.verified);
  let fired = false;
  const hooked = envWithD1Hooks(env, {
    afterQuery: async (sql) => {
      if (fired || !sql.includes('order by "position"')) return;
      fired = true;
      await db.batch([
        db.statement((q) =>
          q
            .updateTable('workspaces')
            .set({ closed_at: AT })
            .where('id', '=', target.workspace.id)
            .where('organization_id', '=', target.organization.id),
        ),
      ]);
    },
  });
  const response = await post(app, workspaceWikiUpload, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, files: files(2) },
    env: hooked,
  });
  expect(fired).toBe(true);
  expect(response.status).toBe(409);
  expect(await errorCodeOf(response)).toBe('workspace_closed');
  expect(
    await db.rows(
      db.statement((q) => q.selectFrom('wiki_pages').select('id').where('workspace_id', '=', target.workspace.id)),
    ),
  ).toEqual([]);
});
