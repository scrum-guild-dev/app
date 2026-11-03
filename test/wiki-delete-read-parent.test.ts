import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiDelete, workspaceWikiDelete } from '../src/shared/operations/wiki/index.ts';
import { uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson } from './operations/world.ts';
import { createTarget } from './operations/world.ts';

const app = createApp(implementedOperations);
const stamp = '2026-11-03T00:00:00.000Z';

for (const kind of ['organization', 'workspace'] as const) {
  async function fixture() {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    async function insert(parent_id: string | null = null, position = 'a0') {
      const id = uuidv7();
      await db.batch([
        db.statement((q) =>
          q.insertInto('wiki_pages').values({
            id,
            organization_id: kind === 'organization' ? target.organization.id : null,
            workspace_id: kind === 'workspace' ? target.workspace.id : null,
            parent_id,
            position,
            title: '架空の移動済みページ',
            body_md: '保持する本文',
            version: 1,
            created_by: target.member.userId!,
            updated_by: target.member.userId!,
            created_at: stamp,
            updated_at: stamp,
          }),
        ),
      ]);
      return id;
    }
    const rows = () =>
      db.rows(
        db.statement((q) => {
          const base = q.selectFrom('wiki_pages').selectAll().orderBy('id');
          return kind === 'organization'
            ? base.where('organization_id', '=', target.organization.id)
            : base.where('workspace_id', '=', target.workspace.id);
        }),
      );
    const remove = (pageId: string, readParentId: string | null, person = target.member) =>
      post(app, kind === 'organization' ? orgWikiDelete : workspaceWikiDelete, {
        slug: target.slug,
        token: person.token,
        body: {
          ...(kind === 'workspace' ? { workspace_id: target.workspace.id } : {}),
          page_id: pageId,
          read_parent_id: readParentId,
        },
      });
    return { target, insert, rows, remove };
  }

  for (const change of ['root-to-parent', 'parent-to-root', 'different-parent'] as const) {
    test(`${kind}: 開いた後に親が変わったら409で断り、ページと子を一切変えない（${change}）`, async () => {
      const f = await fixture();
      const oldParent = change === 'root-to-parent' ? null : await f.insert();
      const currentParent = change === 'parent-to-root' ? null : await f.insert(null, 'a1');
      // クライアントが古い親を覚えている間に、別の要求の移動が既に完了した状態。
      const page = await f.insert(currentParent);
      await f.insert(page);
      await f.insert(currentParent, 'a2');
      const before = await f.rows();
      const response = await f.remove(page, oldParent);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'changed' } } });
      expect(await f.rows()).toEqual(before);
    });
  }

  for (const root of [true, false]) {
    test(`${kind}: 覚えている親が一致すれば削除でき、子はその親の末尾へ上がる（${root ? '最上段' : '子'}）`, async () => {
      const f = await fixture();
      const parent = root ? null : await f.insert();
      const page = await f.insert(parent);
      const sibling = await f.insert(parent, 'a1');
      const child = await f.insert(page);
      const response = await f.remove(page, parent);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ page_id: page });
      const rows = await f.rows();
      expect(rows.find((row) => row.id === page)!.deleted_at).not.toBeNull();
      expect(rows.find((row) => row.id === child)!.parent_id).toBe(parent);
      expect(rows.find((row) => row.id === child)!.position > rows.find((row) => row.id === sibling)!.position).toBe(
        true,
      );
    });
  }

  test(`${kind}: 親が違っていても削除権限を先に確かめ、他の人には403を返す`, async () => {
    const f = await fixture();
    const parent = await f.insert();
    const page = await f.insert(parent);
    await f.insert(page);
    const other = await createPerson({
      organization: f.target.organization,
      membership: { workspaceId: f.target.workspace.id, role: 'member' },
    });
    const before = await f.rows();
    const response = await f.remove(page, null, other);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await f.rows()).toEqual(before);
  });

  test(`${kind}: 別のWikiのページに親のスナップショットを付けても404のまま`, async () => {
    const f = await fixture();
    const foreign = await fixture();
    const page = await foreign.insert();
    const before = await foreign.rows();
    const response = await f.remove(page, uuidv7());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(await foreign.rows()).toEqual(before);
  });
}
