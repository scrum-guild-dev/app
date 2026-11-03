import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  orgWikiCreate,
  orgWikiMove,
  orgWikiPage,
  orgWikiTree,
  workspaceWikiCreate,
  workspaceWikiMove,
  workspaceWikiPage,
  workspaceWikiTree,
  type WikiNode,
  type WikiPage,
} from '../src/shared/operations/wiki/index.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

const app = createApp(implementedOperations);
const definitions = [
  { name: '組織', create: orgWikiCreate, move: orgWikiMove, page: orgWikiPage, tree: orgWikiTree, workspace: false },
  {
    name: 'ワークスペース',
    create: workspaceWikiCreate,
    move: workspaceWikiMove,
    page: workspaceWikiPage,
    tree: workspaceWikiTree,
    workspace: true,
  },
] as const;

for (const definition of definitions) {
  describe(`${definition.name} Wiki の移動`, () => {
    async function fixture() {
      const target = await createTarget();
      function call(operation: AnyOperationDefinition, body: Record<string, unknown> = {}) {
        return post(app, operation, {
          slug: target.slug,
          token: target.member.token,
          body: { ...(definition.workspace ? { workspace_id: target.workspace.id } : {}), ...body },
        });
      }
      async function create(parent_id: string | null = null, title = '手順') {
        const response = await call(definition.create, { parent_id, title, body_md: `# ${title}\n\n本文` });
        expect(response.status).toBe(200);
        return ((await response.json()) as { page: WikiPage }).page;
      }
      async function read(id: string) {
        const response = await call(definition.page, { page_id: id });
        expect(response.status).toBe(200);
        return ((await response.json()) as { page: WikiPage }).page;
      }
      async function tree() {
        const response = await call(definition.tree);
        expect(response.status).toBe(200);
        return ((await response.json()) as { pages: WikiNode[] }).pages;
      }
      async function move(page_id: string, parent_id: string | null, extra: Record<string, unknown> = {}) {
        return call(definition.move, { page_id, parent_id, ...extra });
      }
      async function chain(length: number) {
        const pages: WikiPage[] = [];
        for (let index = 0; index < length; index++) pages.push(await create(pages.at(-1)?.id ?? null));
        return pages;
      }
      const db = orgDb(env, target.organization.verified);
      function scopedUpdate(id: string) {
        return db.statement((q) => {
          const update = q
            .updateTable('wiki_pages')
            .set({ deleted_at: new Date().toISOString(), deleted_by: target.member.userId! })
            .where('id', '=', id);
          return definition.workspace
            ? update.where('workspace_id', '=', target.workspace.id)
            : update.where('organization_id', '=', target.organization.id);
        });
      }
      return { target, call, create, read, tree, move, chain, db, scopedUpdate };
    }

    test('先頭、直後、末尾の順を保存し、読み直しても同じ兄弟順になる', async () => {
      const f = await fixture();
      const a = await f.create(null, '一');
      const b = await f.create(null, '二');
      const c = await f.create(null, '三');
      expect((await f.move(c.id, null, { after_page_id: null })).status).toBe(200);
      expect((await f.tree()).map((page) => page.id)).toEqual([c.id, a.id, b.id]);
      expect((await f.move(b.id, null, { after_page_id: c.id })).status).toBe(200);
      expect((await f.tree()).map((page) => page.id)).toEqual([c.id, b.id, a.id]);
      expect((await f.move(c.id, null)).status).toBe(200);
      expect((await f.tree()).map((page) => page.id)).toEqual([b.id, a.id, c.id]);
      expect((await f.tree()).map((page) => page.id)).toEqual([b.id, a.id, c.id]);
    });

    test('部分木を別の親と最上段へ移し、ID、本文と版、子の親を保つ', async () => {
      const f = await fixture();
      const source = await f.create();
      const moving = await f.create(source.id, '移す手順');
      const child = await f.create(moving.id, '配下の手順');
      const destination = await f.create();
      const response = await f.move(moving.id, destination.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ page_id: moving.id, parent_id: destination.id });
      expect(await f.read(moving.id)).toMatchObject({
        ...moving,
        parent_id: destination.id,
        position: expect.any(String),
      });
      expect(await f.read(child.id)).toEqual(child);
      expect((await f.move(moving.id, null)).status).toBe(200);
      expect(await f.read(moving.id)).toMatchObject({
        id: moving.id,
        title: moving.title,
        body_md: moving.body_md,
        version: moving.version,
        parent_id: null,
      });
      expect(await f.read(child.id)).toEqual(child);
    });

    test('自身と子孫の下への移動は理由つきで断り、元の木を保つ', async () => {
      const f = await fixture();
      const root = await f.create();
      const child = await f.create(root.id);
      const grandchild = await f.create(child.id);
      const before = await f.tree();
      for (const parent of [root.id, child.id, grandchild.id]) {
        const response = await f.move(root.id, parent);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'cycle' } } });
      }
      expect(await f.tree()).toEqual(before);
    });

    test('移した部分木の末端が10段目なら許し、11段目なら理由つきで断る', async () => {
      const f = await fixture();
      const ancestors = await f.chain(9);
      const root = await f.create();
      const child = await f.create(root.id);
      const before = await f.tree();
      const denied = await f.move(root.id, ancestors[8]!.id);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'too_deep' } } });
      expect(await f.tree()).toEqual(before);
      expect((await f.move(root.id, ancestors[7]!.id)).status).toBe(200);
      expect((await f.read(root.id)).parent_id).toBe(ancestors[7]!.id);
      expect((await f.read(child.id)).parent_id).toBe(root.id);
      expect((await f.move(root.id, null)).status).toBe(200);
      expect((await f.read(root.id)).parent_id).toBeNull();
    });

    test('移すページ、親、直前のページに別組織のIDを渡しても404になる', async () => {
      const f = await fixture();
      const other = await fixture();
      const local = await f.create();
      const foreign = await other.create();
      const before = await f.tree();
      for (const body of [
        { page_id: foreign.id, parent_id: null },
        { page_id: local.id, parent_id: foreign.id },
        { page_id: local.id, parent_id: null, after_page_id: foreign.id },
      ]) {
        const response = await f.call(definition.move, body);
        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe('not_found');
      }
      expect(await f.tree()).toEqual(before);
      expect(await other.read(foreign.id)).toEqual(foreign);
    });

    test('別の親の子を直前に指定すると404、自身を直前にすると400になる', async () => {
      const f = await fixture();
      const root = await f.create();
      const child = await f.create(root.id);
      const moving = await f.create();
      const before = await f.tree();
      const wrongSibling = await f.move(moving.id, null, { after_page_id: child.id });
      expect(wrongSibling.status).toBe(404);
      expect(await errorCodeOf(wrongSibling)).toBe('not_found');
      const self = await f.move(moving.id, null, { after_page_id: moving.id });
      expect(self.status).toBe(400);
      expect(await errorCodeOf(self)).toBe('invalid_input');
      expect(await f.tree()).toEqual(before);
    });

    test('削除されたページ、親、直前のページを移動で使えない', async () => {
      const f = await fixture();
      const live = await f.create();
      const deleted = await f.create();
      await f.db.batch([f.scopedUpdate(deleted.id)]);
      for (const body of [
        { page_id: deleted.id, parent_id: null },
        { page_id: live.id, parent_id: deleted.id },
        { page_id: live.id, parent_id: null, after_page_id: deleted.id },
      ]) {
        const response = await f.call(definition.move, body);
        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe('not_found');
      }
      expect(await f.read(live.id)).toEqual(live);
    });

    test('同じpositionの兄弟の間にも、既存の順を保って挿入できる', async () => {
      const f = await fixture();
      const a = await f.create();
      const b = await f.create();
      const moving = await f.create();
      await f.db.batch([
        f.db.statement((q) => {
          const update = q.updateTable('wiki_pages').set({ position: a.position }).where('id', '=', b.id);
          return definition.workspace
            ? update.where('workspace_id', '=', f.target.workspace.id)
            : update.where('organization_id', '=', f.target.organization.id);
        }),
      ]);
      const sorted = [a, b].sort((left, right) => (left.id < right.id ? -1 : 1));
      const first = sorted[0]!;
      const second = sorted[1]!;
      expect((await f.move(moving.id, null, { after_page_id: first.id })).status).toBe(200);
      expect((await f.tree()).map((page) => page.id)).toEqual([first.id, moving.id, second.id]);
      expect((await f.read(first.id)).body_md).toBe(first.body_md);
      expect((await f.read(second.id)).body_md).toBe(second.body_md);
    });
  });
}

test('組織とワークスペースの間では、ページも親も直前のページも使えない', async () => {
  const target = await createTarget();
  async function call(operation: AnyOperationDefinition, body: Record<string, unknown>) {
    return post(app, operation, { slug: target.slug, token: target.member.token, body });
  }
  const orgResponse = await call(orgWikiCreate, { title: '組織の手順', body_md: '本文' });
  const workspaceResponse = await call(workspaceWikiCreate, {
    workspace_id: target.workspace.id,
    title: 'チームの手順',
    body_md: '本文',
  });
  expect(orgResponse.status).toBe(200);
  expect(workspaceResponse.status).toBe(200);
  const org = ((await orgResponse.json()) as { page: WikiPage }).page;
  const workspace = ((await workspaceResponse.json()) as { page: WikiPage }).page;
  for (const [operation, current, foreign, extra] of [
    [orgWikiMove, org, workspace, {}],
    [workspaceWikiMove, workspace, org, { workspace_id: target.workspace.id }],
  ] as const) {
    for (const body of [
      { page_id: foreign.id, parent_id: null },
      { page_id: current.id, parent_id: foreign.id },
      { page_id: current.id, parent_id: null, after_page_id: foreign.id },
    ]) {
      const denied = await call(operation, { ...extra, ...body });
      expect(denied.status).toBe(404);
      expect(await errorCodeOf(denied)).toBe('not_found');
    }
  }
});

test('同じ組織の別ワークスペースのページを移動先や直前のページにできない', async () => {
  const target = await createTarget();
  async function create(workspaceId: string) {
    const response = await post(app, workspaceWikiCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: workspaceId, title: 'チームの手順', body_md: '本文' },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { page: WikiPage }).page;
  }
  const local = await create(target.workspace.id);
  const foreign = await create(target.otherWorkspace.id);
  for (const body of [
    { page_id: foreign.id, parent_id: null },
    { page_id: local.id, parent_id: foreign.id },
    { page_id: local.id, parent_id: null, after_page_id: foreign.id },
  ]) {
    const denied = await post(app, workspaceWikiMove, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id, ...body },
    });
    expect(denied.status).toBe(404);
    expect(await errorCodeOf(denied)).toBe('not_found');
  }
});

test('閉じたワークスペースでは並べ替えも親変更も断る', async () => {
  const target = await createTarget();
  const created = await post(app, workspaceWikiCreate, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, title: '手順', body_md: '本文' },
  });
  expect(created.status).toBe(200);
  const page = ((await created.json()) as { page: WikiPage }).page;
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ closed_at: new Date().toISOString() })
        .where('id', '=', target.workspace.id)
        .where('organization_id', '=', target.organization.id),
    ),
  ]);
  const response = await post(app, workspaceWikiMove, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, page_id: page.id, parent_id: null, after_page_id: null },
  });
  expect(response.status).toBe(409);
  expect(await errorCodeOf(response)).toBe('workspace_closed');
});
