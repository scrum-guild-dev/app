import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  orgWikiDelete,
  orgWikiPage,
  orgWikiRevisions,
  orgWikiSearch,
  orgWikiTree,
  workspaceWikiDelete,
  workspaceWikiPage,
  workspaceWikiRevisions,
  workspaceWikiSearch,
  workspaceWikiTree,
} from '../src/shared/operations/wiki/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget } from './operations/world.ts';

const app = createApp(implementedOperations);
const stamp = '2026-11-03T00:00:00.000Z';

for (const kind of ['organization', 'workspace'] as const) {
  describe(`${kind}: Wiki の削除`, () => {
    const definition = kind === 'organization' ? orgWikiDelete : workspaceWikiDelete;
    async function fixture(closed = false) {
      const target = await createTarget({ closed });
      const db = orgDb(env, target.organization.verified);
      function scoped(q: Parameters<Parameters<typeof db.statement>[0]>[0]) {
        const base = q.selectFrom('wiki_pages').selectAll();
        return kind === 'organization'
          ? base.where('organization_id', '=', target.organization.id)
          : base.where('workspace_id', '=', target.workspace.id);
      }
      async function insert(parent_id: string | null = null, position = 'a0', author = target.member) {
        const id = uuidv7();
        await db.batch([
          db.statement((q) =>
            q.insertInto('wiki_pages').values({
              id,
              organization_id: kind === 'organization' ? target.organization.id : null,
              workspace_id: kind === 'workspace' ? target.workspace.id : null,
              parent_id,
              position,
              title: '架空の削除手順',
              body_md: '削除後にも保持する本文',
              version: 1,
              created_by: author.userId!,
              updated_by: author.userId!,
              created_at: stamp,
              updated_at: stamp,
            }),
          ),
          db.statement((q) =>
            q.insertInto('wiki_page_revisions').values({
              page_id: id,
              version: 1,
              title: '架空の削除手順',
              body_md: '削除後にも保持する本文',
              saved_by: author.userId!,
              saved_at: stamp,
            }),
          ),
        ]);
        return id;
      }
      const row = (id: string) => db.first(db.statement((q) => scoped(q).where('id', '=', id)));
      async function call(
        operation: AnyOperationDefinition,
        body: Record<string, unknown>,
        person = target.member,
        requestEnv: Env = env,
      ) {
        return post(app, operation, {
          slug: target.slug,
          token: person.token,
          body: { ...(kind === 'workspace' ? { workspace_id: target.workspace.id } : {}), ...body },
          env: requestEnv,
        });
      }
      const remove = (id: string, person = target.member, requestEnv: Env = env) =>
        call(definition, { page_id: id }, person, requestEnv);
      async function children(parentId: string | null) {
        return db.rows(
          db.statement((q) =>
            scoped(q)
              .where('parent_id', 'is', parentId)
              .where('deleted_at', 'is', null)
              .orderBy('position')
              .orderBy('id'),
          ),
        );
      }
      return { target, db, insert, row, call, remove, children };
    }

    for (const role of kind === 'workspace'
      ? (['member', 'leader', 'admin'] as const)
      : (['member', 'admin'] as const)) {
      test(`${role} は${role === 'member' ? '自分の' : '他の人の'}ページを論理削除できる`, async () => {
        const f = await fixture();
        const id = await f.insert();
        const before = await f.row(id);
        const response = await f.remove(id, f.target[role]);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ page_id: id });
        const after = await f.row(id);
        expect(after).toMatchObject({ ...before, deleted_by: f.target[role].userId, deleted_at: expect.any(String) });
        expect(Date.parse(after!.deleted_at!)).not.toBeNaN();
        const revisions = await f.db.rows(
          f.db.statement((q) => q.selectFrom('wiki_page_revisions').selectAll().where('page_id', '=', id)),
        );
        expect(revisions).toHaveLength(1);
        expect(revisions[0]).toMatchObject({ body_md: before!.body_md, title: before!.title, version: 1 });
      });
    }

    test('他のメンバーのページは403で断り、子も動かさない', async () => {
      const f = await fixture();
      const other = await createPerson({
        organization: f.target.organization,
        membership: { workspaceId: f.target.workspace.id, role: 'member' },
      });
      const id = await f.insert();
      const child = await f.insert(id);
      const before = await f.row(id);
      const childBefore = await f.row(child);
      const response = await f.remove(id, other);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
      expect(await f.row(id)).toEqual(before);
      expect(await f.row(child)).toEqual(childBefore);
    });

    if (kind === 'organization') {
      test('ワークスペースのリーダーも組織の他の人のページは消せない', async () => {
        const f = await fixture();
        const id = await f.insert();
        expect((await f.remove(id, f.target.leader)).status).toBe(403);
        expect((await f.row(id))!.deleted_at).toBeNull();
      });
    }

    for (const root of [true, false]) {
      test(`${root ? '最上段' : '子'}のページを消すと直属の子だけが移動先の末尾へ元の順で上がる`, async () => {
        const f = await fixture();
        const parent = root ? null : await f.insert();
        const id = await f.insert(parent, 'a0');
        const earlier = await f.insert(parent, 'a1');
        const later = await f.insert(parent, 'a2');
        const second = await f.insert(id, 'a1');
        const first = await f.insert(id, 'a0');
        const grandchild = await f.insert(first, 'a0');
        const retained = [earlier, later, grandchild];
        const before = await Promise.all(retained.map(f.row));
        const firstBefore = await f.row(first);
        const secondBefore = await f.row(second);
        expect((await f.remove(id)).status).toBe(200);
        expect((await f.children(parent)).map((page) => page.id)).toEqual([earlier, later, first, second]);
        expect(await Promise.all(retained.map(f.row))).toEqual(before);
        expect(await f.row(first)).toMatchObject({ ...firstBefore, parent_id: parent, position: expect.any(String) });
        expect(await f.row(second)).toMatchObject({ ...secondBefore, parent_id: parent, position: expect.any(String) });
        expect(await f.children(id)).toEqual([]);
      });
    }

    test('消したページは現在版・過去版・版一覧・木・検索から読めず、もう一度消しても404', async () => {
      const f = await fixture();
      const id = await f.insert();
      expect((await f.remove(id)).status).toBe(200);
      for (const [operation, body] of [
        [kind === 'organization' ? orgWikiPage : workspaceWikiPage, { page_id: id }],
        [kind === 'organization' ? orgWikiPage : workspaceWikiPage, { page_id: id, revision: 1 }],
        [kind === 'organization' ? orgWikiRevisions : workspaceWikiRevisions, { page_id: id }],
      ] as const) {
        const response = await f.call(operation, body);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      }
      const tree = await f.call(kind === 'organization' ? orgWikiTree : workspaceWikiTree, {});
      expect(await tree.json()).toEqual({ pages: [] });
      const search = await f.call(kind === 'organization' ? orgWikiSearch : workspaceWikiSearch, { query: '削除' });
      expect(await search.json()).toEqual({ pages: [] });
      expect((await f.remove(id)).status).toBe(404);
    });

    test('存在しないIDと別の組織のIDを同じ404にし、行と子を変えない', async () => {
      const f = await fixture();
      const foreign = await fixture();
      const id = await foreign.insert();
      const child = await foreign.insert(id);
      const before = await foreign.row(id);
      const childBefore = await foreign.row(child);
      for (const missing of [uuidv7(), id]) {
        const response = await f.remove(missing);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      }
      expect(await foreign.row(id)).toEqual(before);
      expect(await foreign.row(child)).toEqual(childBefore);
    });

    test('同じ組織でも他のWikiのIDを消せない', async () => {
      const f = await fixture();
      const id = uuidv7();
      await f.db.batch([
        f.db.statement((q) =>
          q.insertInto('wiki_pages').values({
            id,
            organization_id: kind === 'organization' ? null : f.target.organization.id,
            workspace_id: kind === 'organization' ? f.target.workspace.id : null,
            parent_id: null,
            position: 'a0',
            title: '別の範囲',
            body_md: '本文',
            version: 1,
            created_by: f.target.member.userId!,
            updated_by: f.target.member.userId!,
            created_at: stamp,
            updated_at: stamp,
          }),
        ),
      ]);
      expect((await f.remove(id)).status).toBe(404);
    });

    test('論理削除と子の付け替えは同じbatchで送り、送信失敗なら何も変わらない', async () => {
      const f = await fixture();
      const id = await f.insert();
      const child = await f.insert(id);
      const before = await f.row(id);
      const childBefore = await f.row(child);
      let intercepted = false;
      const failing = envWithD1Hooks(env, {
        beforeBatch(sqls) {
          if (!sqls.some((sql) => /update\s+["`]?wiki_pages/i.test(sql))) return;
          intercepted = true;
          expect(sqls.length).toBeGreaterThanOrEqual(2);
          throw new Error('架空の送信失敗');
        },
      });
      expect((await f.remove(id, f.target.member, failing)).status).toBe(500);
      expect(intercepted).toBe(true);
      expect(await f.row(id)).toEqual(before);
      expect(await f.row(child)).toEqual(childBefore);
    });

    test('読む間に子が増えても、成功した削除で生きた子を消した親の下へ残さない', async () => {
      const f = await fixture();
      const id = await f.insert();
      const child = await f.insert(id);
      let added: string | null = null;
      let fired = false;
      const racing = envWithD1Hooks(env, {
        afterQuery: async (sql) => {
          if (fired || !/from ["`]?wiki_pages/i.test(sql)) return;
          fired = true;
          added = await f.insert(id, 'a1');
        },
      });
      const response = await f.remove(id, f.target.member, racing);
      expect(fired).toBe(true);
      expect(added).not.toBeNull();
      // 競合を断ることも許すが、一部だけ成功することは許さない。
      expect([200, 409]).toContain(response.status);
      if (response.status === 200) {
        expect((await f.children(null)).map((page) => page.id)).toEqual([child, added]);
        expect(await f.children(id)).toEqual([]);
      } else {
        expect((await f.row(id))!.deleted_at).toBeNull();
        expect((await f.row(child))!.parent_id).toBe(id);
        expect((await f.row(added!))!.parent_id).toBe(id);
      }
    });

    if (kind === 'workspace') {
      test('ページを読んだ直後にワークスペースが閉じたら、子も動かさず断る', async () => {
        const f = await fixture();
        const id = await f.insert();
        const child = await f.insert(id);
        const before = await f.row(id);
        const childBefore = await f.row(child);
        let fired = false;
        const racing = envWithD1Hooks(env, {
          afterQuery: async (sql) => {
            if (fired || !/from ["`]?wiki_pages/i.test(sql)) return;
            fired = true;
            await f.db.batch([
              f.db.statement((q) =>
                q
                  .updateTable('workspaces')
                  .set({ closed_at: stamp })
                  .where('id', '=', f.target.workspace.id)
                  .where('organization_id', '=', f.target.organization.id),
              ),
            ]);
          },
        });
        const response = await f.remove(id, f.target.member, racing);
        expect(fired).toBe(true);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'workspace_closed' } });
        expect(await f.row(id)).toEqual(before);
        expect(await f.row(child)).toEqual(childBefore);
      });
    }

    if (kind === 'workspace') {
      test('閉じたワークスペースでは作った人も管理者も消せない', async () => {
        const f = await fixture(true);
        const id = await f.insert();
        const child = await f.insert(id);
        const before = await f.row(id);
        const childBefore = await f.row(child);
        for (const person of [f.target.member, f.target.admin]) {
          const response = await f.remove(id, person);
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ error: { code: 'workspace_closed' } });
        }
        expect(await f.row(id)).toEqual(before);
        expect(await f.row(child)).toEqual(childBefore);
      });

      test('同じ組織の別ワークスペースのページは消せない', async () => {
        const f = await fixture();
        const id = await f.insert();
        const response = await post(app, workspaceWikiDelete, {
          slug: f.target.slug,
          token: f.target.admin.token,
          body: { workspace_id: f.target.otherWorkspace.id, page_id: id },
        });
        expect(response.status).toBe(404);
        expect((await f.row(id))!.deleted_at).toBeNull();
      });
    }
  });
}
