import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { AT, createEpic, createMembership, createStory, createTask, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
const kinds = ['task', 'story', 'epic', 'wiki_page'] as const;
type Kind = (typeof kinds)[number];
type Item = {
  id: string;
  target_type: Kind;
  target_id: string;
  workspace_id: string | null;
  title: string;
  created_at: string;
};

function set(target: Target, kind: Kind, id: string, value = true, person = target.member) {
  return post(app, favoriteSet, {
    slug: target.slug,
    token: person.token,
    body: { target_type: kind, target_id: id, is_favorite: value },
  });
}
async function list(target: Target, person = target.member): Promise<Item[]> {
  const res = await post(app, favoriteList, { slug: target.slug, token: person.token, body: {} });
  expect(res.status).toBe(200);
  return favoriteList.output.parse(await res.json()).favorites;
}
async function make(target: Target, kind: Kind, workspaceId: string | null = target.workspace.id) {
  if (kind === 'task') return createTask(target.organization, workspaceId!, target.admin.userId!);
  if (kind === 'story') return createStory(target.organization, workspaceId!, target.admin.userId!);
  if (kind === 'epic') return createEpic(target.organization, workspaceId!, target.admin.userId!);
  const row = {
    id: uuidv7(),
    organization_id: workspaceId === null ? target.organization.id : null,
    workspace_id: workspaceId,
    parent_id: null,
    title: 'お気に入りの手引き',
    body_md: '手順',
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
async function favorites(target: Target, person: Person = target.member) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(db.statement((q) => q.selectFrom('favorites').selectAll().where('user_id', '=', person.userId!)));
}
async function deleted(target: Target, kind: Kind, id: string, value: string | null) {
  const table = { task: 'tasks', story: 'stories', epic: 'epics', wiki_page: 'wiki_pages' } as const;
  const db = orgDb(env, target.organization.verified);
  if (kind === 'wiki_page') {
    await db.run(
      db.statement((q) =>
        q
          .updateTable('wiki_pages')
          .set({ deleted_at: value, deleted_by: value === null ? null : target.admin.userId! })
          .where('id', '=', id),
      ),
    );
    return;
  }
  await db.run(db.statement((q) => q.updateTable(table[kind]).set({ deleted_at: value }).where('id', '=', id)));
}

describe('自分だけのお気に入り', () => {
  test('空の一覧', async () => {
    expect(await list(await createTarget())).toEqual([]);
  });
  test.each(kinds)('%s を付け、二度付けても同じ1行、二度外しても成功する', async (kind) => {
    const target = await createTarget();
    const item = await make(target, kind);
    expect((await set(target, kind, item.id)).status).toBe(200);
    const first = await list(target);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      target_type: kind,
      target_id: item.id,
      title: item.title,
      workspace_id: target.workspace.id,
    });
    expect((await set(target, kind, item.id)).status).toBe(200);
    expect(await list(target)).toEqual(first);
    expect(await favorites(target)).toHaveLength(1);
    expect(await (await set(target, kind, item.id, false)).json()).toEqual({ is_favorite: false });
    expect((await set(target, kind, item.id, false)).status).toBe(200);
    expect(await list(target)).toEqual([]);
    expect(await favorites(target)).toHaveLength(0);
  });
  test('組織の Wiki は workspace_id が空で付け外しできる', async () => {
    const target = await createTarget();
    const item = await make(target, 'wiki_page', null);
    expect((await set(target, 'wiki_page', item.id)).status).toBe(200);
    expect(await list(target)).toEqual([
      expect.objectContaining({ target_type: 'wiki_page', target_id: item.id, workspace_id: null, title: item.title }),
    ]);
    expect((await set(target, 'wiki_page', item.id, false)).status).toBe(200);
    expect(await favorites(target)).toHaveLength(0);
  });
  test('同じ対象を別のメンバーが付けても、お互いの行を読んだり消したりしない', async () => {
    const target = await createTarget();
    const item = await make(target, 'task');
    expect((await set(target, 'task', item.id)).status).toBe(200);
    expect(await list(target, target.leader)).toEqual([]);
    expect((await set(target, 'task', item.id, true, target.leader)).status).toBe(200);
    expect((await set(target, 'task', item.id, false, target.leader)).status).toBe(200);
    expect(await list(target)).toHaveLength(1);
    expect(await list(target, target.leader)).toEqual([]);
  });
  test('種類を混ぜて付けた新しい順に返す', async () => {
    const target = await createTarget();
    const ids: string[] = [];
    for (const kind of kinds) {
      const item = await make(target, kind);
      expect((await set(target, kind, item.id)).status).toBe(200);
      ids.unshift(item.id);
    }
    expect((await list(target)).map((item) => item.target_id)).toEqual(ids);
  });
  test.each(['inbox', 'archive'] as const)('取り込んだタスクは %s にあっても付けられる', async (tray) => {
    const target = await createTarget();
    const item = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      is_imported: 1,
      tray,
    });
    expect((await set(target, 'task', item.id)).status).toBe(200);
    expect((await list(target)).map((row) => row.target_id)).toEqual([item.id]);
  });
  test('付け外しを change_logs に残さない', async () => {
    const target = await createTarget();
    const item = await make(target, 'task');
    const db = orgDb(env, target.organization.verified);
    const logs = () =>
      db.rows(
        db.statement((q) =>
          q.selectFrom('change_logs').select('id').where('organization_id', '=', target.organization.id),
        ),
      );
    const before = await logs();
    expect((await set(target, 'task', item.id)).status).toBe(200);
    expect((await set(target, 'task', item.id, false)).status).toBe(200);
    expect(await logs()).toEqual(before);
  });
});

describe('お気に入りの見える範囲', () => {
  test.each(kinds)('%s: 別の組織と存在しない ID は 404', async (kind) => {
    const target = await createTarget();
    const other = await createTarget();
    const item = await make(other, kind);
    for (const id of [item.id, uuidv7()]) {
      const res = await set(target, kind, id);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });
  test.each(kinds)('%s: 所属していないワークスペースは 404、管理者は付けられる', async (kind) => {
    const target = await createTarget();
    const item = await make(target, kind, target.otherWorkspace.id);
    expect((await set(target, kind, item.id)).status).toBe(404);
    expect((await set(target, kind, item.id, true, target.admin)).status).toBe(200);
    expect((await list(target, target.admin)).map((row) => row.target_id)).toEqual([item.id]);
  });
  test.each(kinds)('%s: 削除済みは付けられず、削除後は行を残して隠れ、取り消すと戻る', async (kind) => {
    const target = await createTarget();
    const item = await make(target, kind);
    expect((await set(target, kind, item.id)).status).toBe(200);
    const before = await favorites(target);
    await deleted(target, kind, item.id, AT);
    expect(await list(target)).toEqual([]);
    expect(await favorites(target)).toEqual(before);
    expect((await set(target, kind, item.id)).status).toBe(404);
    await deleted(target, kind, item.id, null);
    expect((await list(target)).map((row) => row.target_id)).toEqual([item.id]);
  });
  test('所属を外れた対象は行を残して隠れ、所属が戻れば再表示する', async () => {
    const target = await createTarget();
    const item = await make(target, 'task');
    expect((await set(target, 'task', item.id)).status).toBe(200);
    const before = await favorites(target);
    const db = orgDb(env, target.organization.verified);
    const update = async (left_at: string | null) =>
      db.run(
        db.statement((q) =>
          q
            .updateTable('memberships')
            .set({ left_at, left_on: left_at ? '2026-11-09' : null })
            .where('workspace_id', '=', target.workspace.id)
            .where('user_id', '=', target.member.userId!),
        ),
      );
    // 他のワークスペースの所属で組織へのアクセス自体は維持する。
    await createMembership(target.organization, target.otherWorkspace.id, target.member.userId!);
    await update(AT);
    expect(await list(target)).toEqual([]);
    expect(await favorites(target)).toEqual(before);
    expect((await set(target, 'task', item.id)).status).toBe(404);
    await update(null);
    expect((await list(target)).map((row) => row.target_id)).toEqual([item.id]);
  });
  test.each(kinds)('%s: 閉じたワークスペースの対象を隠す（管理者も同じ）、行は残す', async (kind) => {
    const target = await createTarget();
    const item = await make(target, kind);
    expect((await set(target, kind, item.id)).status).toBe(200);
    expect((await set(target, kind, item.id, true, target.admin)).status).toBe(200);
    const before = await favorites(target);
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
    expect(await list(target)).toEqual([]);
    expect(await list(target, target.admin)).toEqual([]);
    expect(await favorites(target)).toEqual(before);
  });
  test('組織の Wiki の別組織 ID も 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const item = await make(other, 'wiki_page', null);
    expect((await set(target, 'wiki_page', item.id)).status).toBe(404);
  });
});

describe('お気に入りの上限', () => {
  test('20件までは成功、21件目は favorite_limit、既存の再送と取り外しは成功', async () => {
    const target = await createTarget();
    let first = '';
    for (let i = 0; i < 20; i++) {
      const item = await make(target, 'task');
      first ||= item.id;
      expect((await set(target, 'task', item.id)).status).toBe(200);
    }
    const extra = await make(target, 'task');
    const res = await set(target, 'task', extra.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'favorite_limit', details: { used: 20, limit: 20 } } });
    expect((await set(target, 'task', first)).status).toBe(200);
    expect(await favorites(target)).toHaveLength(20);
    expect((await set(target, 'task', first, false)).status).toBe(200);
    expect((await set(target, 'task', extra.id)).status).toBe(200);
    expect(await favorites(target)).toHaveLength(20);
  });
  test('一覧に出ない削除済みのお気に入りも20件の上限に数える', async () => {
    const target = await createTarget();
    for (let i = 0; i < 20; i++) {
      const item = await make(target, 'task');
      expect((await set(target, 'task', item.id)).status).toBe(200);
      await deleted(target, 'task', item.id, AT);
    }
    expect(await list(target)).toEqual([]);
    const extra = await make(target, 'task');
    const res = await set(target, 'task', extra.id);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('favorite_limit');
  });
  test('19件から別の2件を同時に付けても20件を超えない', async () => {
    const target = await createTarget();
    for (let i = 0; i < 19; i++) {
      const item = await make(target, 'task');
      expect((await set(target, 'task', item.id)).status).toBe(200);
    }
    const a = await make(target, 'task');
    const b = await make(target, 'task');
    const responses = await Promise.all([set(target, 'task', a.id), set(target, 'task', b.id)]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await favorites(target)).toHaveLength(20);
  });
});
