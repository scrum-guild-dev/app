import { env } from 'cloudflare:workers';
import { generateKeyBetween } from 'fractional-indexing';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, readWikiPage, readWikiTree, type WikiScope } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
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
    const scope: WikiScope =
      kind === 'organization' ? { organizationId: target.organization.id } : { workspaceId: target.workspace.id };
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
            title: '架空の反証手順',
            body_md: '変えない本文',
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
    const read = (id: string) => readWikiPage(db, scope, id);
    const tree = () => readWikiTree(db, scope);
    async function mutate(id: string, values: { parent_id?: string | null; created_by?: string }) {
      await db.batch([
        db.statement((q) => {
          const base = q.updateTable('wiki_pages').set(values).where('id', '=', id);
          return kind === 'organization'
            ? base.where('organization_id', '=', target.organization.id)
            : base.where('workspace_id', '=', target.workspace.id);
        }),
      ]);
    }
    async function remove(id: string, mutation?: () => Promise<unknown>) {
      let fired = false;
      const requestEnv = mutation
        ? envWithD1Hooks(env, {
            afterQuery: async (sql) => {
              if (fired || !/from ["`]?wiki_pages/i.test(sql)) return;
              fired = true;
              await mutation();
            },
          })
        : env;
      const response = await post(app, kind === 'organization' ? orgWikiDelete : workspaceWikiDelete, {
        slug: target.slug,
        token: target.member.token,
        env: requestEnv,
        body: { page_id: id, ...(kind === 'workspace' ? { workspace_id: target.workspace.id } : {}) },
      });
      if (mutation) expect(fired).toBe(true);
      return response;
    }
    return { target, insert, read, tree, mutate, remove };
  }

  test(`${kind}: 20件の同値の子もID順のまま末尾へ上げ、その位置の間へ再配置できる`, async () => {
    const f = await fixture();
    const parent = await f.insert();
    const id = await f.insert(parent);
    const sibling = await f.insert(parent, 'a1');
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await f.insert(id));
    expect((await f.remove(id)).status).toBe(200);
    const children = (await f.tree()).filter((p) => p.parent_id === parent);
    expect(children.map((p) => p.id)).toEqual([sibling, ...ids.sort()]);
    for (let i = 1; i < children.length; i++) {
      const before = children[i - 1]!.position,
        after = children[i]!.position;
      const key = generateKeyBetween(before, after);
      expect(before < key && key < after).toBe(true);
    }
    const last = children.at(-1)!.position;
    expect(generateKeyBetween(last, null) > last).toBe(true);
  });

  test(`${kind}: 読んだ後にページの親が変わったら古い親へ子を移さない`, async () => {
    const f = await fixture();
    const first = await f.insert();
    const second = await f.insert(null, 'a1');
    const id = await f.insert(first);
    const child = await f.insert(id);
    const before = await f.read(child);
    const response = await f.remove(id, () => f.mutate(id, { parent_id: second }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'changed' } } });
    expect(await f.read(id)).toMatchObject({ parent_id: second });
    expect(await f.read(child)).toEqual(before);
  });

  test(`${kind}: 親を別の要求が先に消してページを上げたら今回の削除を競合にする`, async () => {
    const f = await fixture();
    const parent = await f.insert();
    const id = await f.insert(parent);
    const child = await f.insert(id);
    const response = await f.remove(id, async () => expect((await f.remove(parent)).status).toBe(200));
    expect(response.status).toBe(409);
    expect(await f.read(parent)).toBeUndefined();
    expect(await f.read(id)).toMatchObject({ parent_id: null });
    expect(await f.read(child)).toMatchObject({ parent_id: id });
  });

  test(`${kind}: 読み取り後の作成者の変化では権限を再確認し子も動かさない`, async () => {
    const f = await fixture();
    const id = await f.insert();
    const child = await f.insert(id);
    const before = await f.read(child);
    const response = await f.remove(id, () => f.mutate(id, { created_by: f.target.admin.userId! }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await f.read(id)).toBeDefined();
    expect(await f.read(child)).toEqual(before);
  });

  test(`${kind}: 読む間に移動先の兄弟が増えてもその新しい末尾より後ろに子を上げる`, async () => {
    const f = await fixture();
    const id = await f.insert();
    const child = await f.insert(id);
    let sibling = '';
    const response = await f.remove(id, async () => {
      sibling = await f.insert(null, 'a9');
    });
    expect(response.status).toBe(200);
    expect((await f.tree()).filter((p) => p.parent_id === null).map((p) => p.id)).toEqual([sibling, child]);
  });

  test(`${kind}: 同じページの削除が先に通ったとき後の要求は404となり子を二度動かさない`, async () => {
    const f = await fixture();
    const id = await f.insert();
    const child = await f.insert(id);
    let afterFirst: Awaited<ReturnType<typeof f.read>>;
    const response = await f.remove(id, async () => {
      expect((await f.remove(id)).status).toBe(200);
      afterFirst = await f.read(child);
    });
    expect(response.status).toBe(404);
    expect(await f.read(child)).toEqual(afterFirst!);
  });
}
