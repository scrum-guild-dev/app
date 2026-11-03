import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, runStatementsForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiDelete, workspaceWikiDelete } from '../src/shared/operations/wiki/index.ts';
import { uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

const app = createApp(implementedOperations);
const stamp = '2026-11-03T00:00:00.000Z';

for (const kind of ['organization', 'workspace'] as const) {
  async function fixture() {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    async function insert(parent_id: string | null = null, deleted = false) {
      const id = uuidv7();
      await db.batch([
        db.statement((q) =>
          q.insertInto('wiki_pages').values({
            id,
            organization_id: kind === 'organization' ? target.organization.id : null,
            workspace_id: kind === 'workspace' ? target.workspace.id : null,
            parent_id,
            position: 'a0',
            title: '架空の削除テスト',
            body_md: '保持する本文',
            version: 1,
            created_by: target.member.userId!,
            updated_by: target.member.userId!,
            created_at: stamp,
            updated_at: stamp,
            deleted_at: deleted ? stamp : null,
            deleted_by: deleted ? target.member.userId! : null,
          }),
        ),
      ]);
      return id;
    }
    const row = (id: string) =>
      db.first(
        db.statement((q) => {
          const base = q.selectFrom('wiki_pages').selectAll().where('id', '=', id);
          return kind === 'organization'
            ? base.where('organization_id', '=', target.organization.id)
            : base.where('workspace_id', '=', target.workspace.id);
        }),
      );
    const remove = (id: string, requestEnv: Env = env) =>
      post(app, kind === 'organization' ? orgWikiDelete : workspaceWikiDelete, {
        slug: target.slug,
        token: target.member.token,
        env: requestEnv,
        body: { ...(kind === 'workspace' ? { workspace_id: target.workspace.id } : {}), page_id: id },
      });
    return { target, insert, row, remove };
  }

  test(`${kind}: 子の付け替えがSQLエラーなら、同じbatchの論理削除も巻き戻る`, async () => {
    const f = await fixture();
    const id = await f.insert();
    const child = await f.insert(id);
    const before = await f.row(id);
    const childBefore = await f.row(child);
    const trigger = `wiki_delete_fail_${uuidv7().replaceAll('-', '')}`;
    await runStatementsForTest(env, [
      `CREATE TRIGGER ${trigger} BEFORE UPDATE OF parent_id ON wiki_pages
       WHEN OLD.id = '${child}'
       BEGIN SELECT RAISE(ABORT, 'wiki-delete-test'); END`,
    ]);
    let sawBatch = false;
    const observed = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (sqls.some((sql) => /update\s+["`]?wiki_pages/i.test(sql))) {
          sawBatch = true;
          expect(sqls.length).toBeGreaterThanOrEqual(2);
        }
      },
    });
    try {
      const response = await f.remove(id, observed);
      expect(sawBatch).toBe(true);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: 'internal' } });
      expect(await f.row(id)).toEqual(before);
      expect(await f.row(child)).toEqual(childBefore);
    } finally {
      await runStatementsForTest(env, [`DROP TRIGGER ${trigger}`]);
    }
  });

  test(`${kind}: 既に消えた子は1つ上へ移さず、論理削除の記録と内容を保持する`, async () => {
    const f = await fixture();
    const id = await f.insert();
    const child = await f.insert(id);
    const deletedChild = await f.insert(id, true);
    const before = await f.row(deletedChild);
    const response = await f.remove(id);
    expect(response.status).toBe(200);
    expect((await f.row(child))!.parent_id).toBeNull();
    expect(await f.row(deletedChild)).toEqual(before);
  });
}
