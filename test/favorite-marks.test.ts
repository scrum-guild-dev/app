import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { AT, createEpic, createMembership, createStory, createTask, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const kinds = ['task', 'story', 'epic', 'wiki_page'] as const;
type Kind = (typeof kinds)[number];
async function make(target: Target, kind: Kind) {
  if (kind === 'task') return createTask(target.organization, target.workspace.id, target.admin.userId!);
  if (kind === 'story') return createStory(target.organization, target.workspace.id, target.admin.userId!);
  if (kind === 'epic') return createEpic(target.organization, target.workspace.id, target.admin.userId!);
  const row = {
    id: uuidv7(),
    organization_id: null,
    workspace_id: target.workspace.id,
    parent_id: null,
    title: '架空のお気に入り手引き',
    body_md: '本文',
    version: 1,
    position: 'a0',
    created_by: target.admin.userId!,
    updated_by: target.admin.userId!,
    created_at: AT,
    updated_at: AT,
    deleted_at: null,
    deleted_by: null,
  };
  const db = orgDb(env, target.organization.verified);
  await db.run(db.statement((q) => q.insertInto('wiki_pages').values(row)));
  return row;
}
async function set(target: Target, kind: Kind, id: string, is_favorite = true, person = target.member) {
  const response = await post(app, favoriteSet, {
    slug: target.slug,
    token: person.token,
    body: { target_type: kind, target_id: id, is_favorite },
  });
  expect(response.status).toBe(200);
}
async function list(target: Target, person: Person = target.member) {
  const response = await post(app, favoriteList, { slug: target.slug, token: person.token, body: {} });
  expect(response.status).toBe(200);
  return favoriteList.output.parse(await response.json());
}

describe('メニューとは独立した本人の印', () => {
  test('印が無いときは空配列を返す', async () => {
    expect(await list(await createTarget())).toEqual({ favorites: [], marks: [] });
  });
  test.each(kinds)('%s: 閉じたワークスペースの印を返し、メニューには出さず、1回で外せる', async (kind) => {
    const target = await createTarget();
    const item = await make(target, kind);
    await set(target, kind, item.id);
    const expected = [{ target_type: kind, target_id: item.id }];
    expect((await list(target)).marks).toEqual(expected);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: AT })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );
    expect(await list(target)).toEqual({ favorites: [], marks: expected });
    expect((await list(target, target.leader)).marks).toEqual([]);
    await set(target, kind, item.id, true, target.admin);
    expect(await list(target, target.admin)).toEqual({ favorites: [], marks: expected });
    await set(target, kind, item.id, false);
    expect((await list(target)).marks).toEqual([]);
    expect((await list(target, target.admin)).marks).toEqual(expected);
  });
  test.each(kinds)('%s: 削除済み対象の印と別組織の印を返さない', async (kind) => {
    const target = await createTarget();
    const other = await createTarget();
    const item = await make(target, kind);
    await set(target, kind, item.id);
    expect((await list(other)).marks).toEqual([]);
    const db = orgDb(env, target.organization.verified);
    const table = { task: 'tasks', story: 'stories', epic: 'epics', wiki_page: 'wiki_pages' } as const;
    if (kind === 'wiki_page') {
      await db.run(
        db.statement((q) =>
          q
            .updateTable('wiki_pages')
            .set({ deleted_at: AT, deleted_by: target.admin.userId! })
            .where('id', '=', item.id),
        ),
      );
    } else {
      await db.run(db.statement((q) => q.updateTable(table[kind]).set({ deleted_at: AT }).where('id', '=', item.id)));
    }
    expect(await list(target)).toEqual({ favorites: [], marks: [] });
  });
  test.each(kinds)('%s: 所属を失った対象の印を返さず、所属し直すと戻す', async (kind) => {
    const target = await createTarget();
    const item = await make(target, kind);
    await set(target, kind, item.id);
    await createMembership(target.organization, target.otherWorkspace.id, target.member.userId!);
    const db = orgDb(env, target.organization.verified);
    const change = (left_at: string | null) =>
      db.run(
        db.statement((q) =>
          q
            .updateTable('memberships')
            .set({ left_at, left_on: left_at ? '2026-11-09' : null })
            .where('workspace_id', '=', target.workspace.id)
            .where('user_id', '=', target.member.userId!),
        ),
      );
    await change(AT);
    expect(await list(target)).toEqual({ favorites: [], marks: [] });
    await change(null);
    expect((await list(target)).marks).toEqual([{ target_type: kind, target_id: item.id }]);
  });
});
