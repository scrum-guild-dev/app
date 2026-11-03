import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, readWikiPage, type WikiScope } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiMove, workspaceWikiMove } from '../src/shared/operations/wiki/index.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';
import { uuidv7 } from './factories.ts';

const app = createApp(implementedOperations);
for (const kind of ['organization', 'workspace'] as const) {
  async function fixture() {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const scope: WikiScope =
      kind === 'organization' ? { organizationId: target.organization.id } : { workspaceId: target.workspace.id };
    async function insert(parent_id: string | null = null, position = 'a0') {
      const id = uuidv7();
      const at = new Date().toISOString();
      await db.batch([
        db.statement((q) =>
          q.insertInto('wiki_pages').values({
            id,
            organization_id: kind === 'organization' ? target.organization.id : null,
            workspace_id: kind === 'workspace' ? target.workspace.id : null,
            parent_id,
            position,
            title: '架空の移動手順',
            body_md: '本文',
            version: 1,
            created_by: target.member.userId!,
            updated_by: target.member.userId!,
            created_at: at,
            updated_at: at,
          }),
        ),
      ]);
      return (await readWikiPage(db, scope, id))!;
    }
    async function mutate(id: string, values: { parent_id?: string | null; position?: string; deleted_at?: string }) {
      await db.batch([
        db.statement((q) => {
          const update = q
            .updateTable('wiki_pages')
            .set({ ...values, ...(values.deleted_at ? { deleted_by: target.member.userId! } : {}) })
            .where('id', '=', id);
          return kind === 'organization'
            ? update.where('organization_id', '=', target.organization.id)
            : update.where('workspace_id', '=', target.workspace.id);
        }),
      ]);
    }
    async function move(
      id: string,
      parent: string | null,
      after: string | undefined,
      mutation: () => Promise<unknown>,
    ) {
      let fired = false;
      const hooked = envWithD1Hooks(env, {
        afterQuery: async (sql) => {
          if (!fired && sql.includes('order by "position"')) {
            fired = true;
            await mutation();
          }
        },
      });
      const response = await post(app, kind === 'organization' ? orgWikiMove : workspaceWikiMove, {
        slug: target.slug,
        token: target.member.token,
        body: {
          ...(kind === 'workspace' ? { workspace_id: target.workspace.id } : {}),
          page_id: id,
          parent_id: parent,
          ...(after ? { after_page_id: after } : {}),
        },
        env: hooked,
      });
      expect(fired).toBe(true);
      return response;
    }
    return { insert, mutate, move, read: (id: string) => readWikiPage(db, scope, id) };
  }

  for (const change of ['delete', 'reparent'] as const) {
    test(`${kind}: 読んだ直前ページが${change === 'delete' ? '消えた' : '別の親へ移った'}ら404で断る`, async () => {
      const f = await fixture();
      const anchor = await f.insert();
      const destination = await f.insert(null, 'a1');
      const moving = await f.insert(null, 'a2');
      const response = await f.move(moving.id, null, anchor.id, () =>
        f.mutate(
          anchor.id,
          change === 'delete' ? { deleted_at: new Date().toISOString() } : { parent_id: destination.id },
        ),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      expect(await f.read(moving.id)).toEqual(moving);
      expect(await f.read(destination.id)).toEqual(destination);
    });
  }

  for (const deleted of ['moving', 'parent'] as const) {
    test(`${kind}: 読んだ後に${deleted === 'moving' ? '移すページ' : '移す先の親'}が消えたら書かず404にする`, async () => {
      const f = await fixture();
      const parent = await f.insert();
      const moving = await f.insert(null, 'a1');
      const response = await f.move(moving.id, parent.id, undefined, () =>
        f.mutate(deleted === 'moving' ? moving.id : parent.id, { deleted_at: new Date().toISOString() }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      if (deleted === 'parent') expect(await f.read(moving.id)).toEqual(moving);
      else expect(await f.read(moving.id)).toBeUndefined();
    });
  }

  for (const change of ['position', 'parent'] as const) {
    test(`${kind}: 移すページの${change === 'position' ? '位置' : '親'}が先に変わったら上書きしない`, async () => {
      const f = await fixture();
      const parent = await f.insert();
      const moving = await f.insert(null, 'a1');
      const response = await f.move(moving.id, null, undefined, () =>
        f.mutate(moving.id, change === 'position' ? { position: 'a3' } : { parent_id: parent.id }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'changed' } } });
      expect(await f.read(moving.id)).toMatchObject({
        ...moving,
        ...(change === 'position' ? { position: 'a3' } : { parent_id: parent.id }),
      });
      expect(await f.read(parent.id)).toEqual(parent);
    });
  }
}
