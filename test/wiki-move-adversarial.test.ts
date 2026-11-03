import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { generateKeyBetween } from 'fractional-indexing';
import { createApp } from '../src/server/app.ts';
import { orgDb, readWikiPage, readWikiTree, type WikiScope } from '../src/server/db/index.ts';
import {
  compiledQueryForTest,
  envWithD1Hooks,
  queryPlanForTest,
  wikiMoveStatementForTest,
} from '../src/server/db/testing.ts';
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
            title: '架空の手順',
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
          const update = q.updateTable('wiki_pages').set(values).where('id', '=', id);
          return kind === 'organization'
            ? update.where('organization_id', '=', target.organization.id)
            : update.where('workspace_id', '=', target.workspace.id);
        }),
      ]);
    }
    async function move(
      id: string,
      parent: string | null,
      extra: Record<string, unknown> = {},
      mutation?: () => Promise<unknown>,
    ) {
      let fired = false;
      const hooked = mutation
        ? envWithD1Hooks(env, {
            afterQuery: async (sql) => {
              if (!fired && sql.includes('order by "position"')) {
                fired = true;
                await mutation();
              }
            },
          })
        : env;
      const result = await post(app, kind === 'organization' ? orgWikiMove : workspaceWikiMove, {
        slug: target.slug,
        token: target.member.token,
        body: {
          ...(kind === 'workspace' ? { workspace_id: target.workspace.id } : {}),
          page_id: id,
          parent_id: parent,
          ...extra,
        },
        env: hooked,
      });
      if (mutation) expect(fired).toBe(true);
      return result;
    }
    return { target, db, scope, insert, mutate, move, tree: () => readWikiTree(db, scope) };
  }

  test(`${kind}: 移動の再帰SQLは祖先の主キーと子のWiki索引を検索し、ページを全件走査しない`, async () => {
    const f = await fixture();
    const moving = await f.insert();
    const parent = await f.insert(null, 'a1');
    const statement = wikiMoveStatementForTest(f.db, f.scope, moving, parent.id, 'a2', [parent]);
    const compiled = compiledQueryForTest(statement);
    expect(compiled.parameters.length).toBeLessThanOrEqual(100);
    const plan = await queryPlanForTest(env, statement);
    expect(plan.some((line) => /SEARCH p USING INDEX sqlite_autoindex_wiki_pages_1/.test(line))).toBe(true);
    expect(
      plan.some((line) => line.includes(`wiki_pages_${kind}_tree`) && line.includes('parent_id=?')),
      plan.join('\n'),
    ).toBe(true);
    expect(plan.filter((line) => /^SCAN (?:p|g|wiki_pages)(?:\s|$)/.test(line))).toEqual([]);
  });

  test(`${kind}: 読んだ後に移す先が子孫へ変わっても、書き込み時に循環を拒否する`, async () => {
    const f = await fixture();
    const moving = await f.insert();
    const child = await f.insert(moving.id);
    const parent = await f.insert(null, 'a1');
    const response = await f.move(moving.id, parent.id, {}, () => f.mutate(parent.id, { parent_id: child.id }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'cycle' } } });
    expect((await readWikiPage(f.db, f.scope, moving.id))?.parent_id).toBeNull();
  });

  test(`${kind}: 読んだ後に部分木が伸びても、11段目を作らない`, async () => {
    const f = await fixture();
    let parent: string | null = null;
    for (let i = 0; i < 8; i++) parent = (await f.insert(parent)).id;
    const moving = await f.insert(null, 'a1');
    const child = await f.insert(moving.id);
    const response = await f.move(moving.id, parent, {}, () => f.insert(child.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'too_deep' } } });
    expect((await readWikiPage(f.db, f.scope, moving.id))?.parent_id).toBeNull();
  });

  test(`${kind}: 読んだ兄弟が動いたら、位置の上書きと一部だけの振り直しをしない`, async () => {
    const f = await fixture();
    const anchor = await f.insert();
    const tie = await f.insert();
    const sorted = [anchor, tie].sort((a, b) => (a.id < b.id ? -1 : 1));
    const moving = await f.insert(null, 'a1');
    const response = await f.move(moving.id, null, { after_page_id: sorted[0]!.id }, () =>
      f.mutate(sorted[1]!.id, { position: 'a2' }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'changed' } } });
    expect((await readWikiPage(f.db, f.scope, moving.id))?.position).toBe(moving.position);
    expect((await readWikiPage(f.db, f.scope, sorted[0]!.id))?.position).toBe('a0');
    expect((await readWikiPage(f.db, f.scope, sorted[1]!.id))?.position).toBe('a2');
  });

  for (const tieCount of [40, 41]) {
    test(`${kind}: 同位置の後続${tieCount}件は${tieCount === 40 ? '束縛上限以内でまとめて振り直す' : '何も変えず断る'}`, async () => {
      const f = await fixture();
      const ties = [];
      for (let i = 0; i < tieCount + 1; i++) ties.push(await f.insert());
      ties.sort((a, b) => (a.id < b.id ? -1 : 1));
      const moving = await f.insert(null, generateKeyBetween('a0', null));
      const before = await f.tree();
      const response = await f.move(moving.id, null, { after_page_id: ties[0]!.id });
      if (tieCount === 41) {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'ties' } } });
        expect(await f.tree()).toEqual(before);
      } else {
        expect(response.status).toBe(200);
        const after = await f.tree();
        expect(after.map((row) => row.id)).toEqual([ties[0]!.id, moving.id, ...ties.slice(1).map((row) => row.id)]);
        expect(new Set(after.map((row) => row.position)).size).toBe(after.length);
      }
    });
  }

  if (kind === 'workspace')
    test('workspace: 権限検査後に閉じても、並べ替えと振り直しを書かない', async () => {
      const f = await fixture();
      const parent = await f.insert();
      const moving = await f.insert(null, 'a1');
      const before = await f.tree();
      const response = await f.move(moving.id, null, { after_page_id: parent.id }, async () => {
        await f.db.batch([
          f.db.statement((q) =>
            q
              .updateTable('workspaces')
              .set({ closed_at: new Date().toISOString() })
              .where('id', '=', f.target.workspace.id)
              .where('organization_id', '=', f.target.organization.id),
          ),
        ]);
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'workspace_closed' } });
      expect(await f.tree()).toEqual(before);
    });
}
