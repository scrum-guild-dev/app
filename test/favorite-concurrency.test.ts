import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { AT, createMembership, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
function set(target: Target, id: string, value = true, person: Person = target.member) {
  return post(app, favoriteSet, {
    slug: target.slug,
    token: person.token,
    body: { target_type: 'task', target_id: id, is_favorite: value },
  });
}
async function list(target: Target, person: Person = target.member) {
  const response = await post(app, favoriteList, { slug: target.slug, token: person.token, body: {} });
  expect(response.status).toBe(200);
  return favoriteList.output.parse(await response.json()).favorites;
}
function database(target: Target) {
  return orgDb(env, target.organization.verified);
}
async function stored(target: Target, person: Person = target.member) {
  const db = database(target);
  return db.rows(db.statement((q) => q.selectFrom('favorites').select('id').where('user_id', '=', person.userId!)));
}
async function task(target: Target) {
  return createTask(target.organization, target.workspace.id, target.admin.userId!);
}

describe('お気に入りの反証: 隠れた印と競合', () => {
  test('削除済みで一覧から消えた本人の印は解除できるが、他人の印は消えない', async () => {
    const target = await createTarget();
    const item = await task(target);
    expect((await set(target, item.id)).status).toBe(200);
    expect((await set(target, item.id, true, target.leader)).status).toBe(200);
    const db = database(target);
    await db.run(db.statement((q) => q.updateTable('tasks').set({ deleted_at: AT }).where('id', '=', item.id)));
    expect(await list(target)).toEqual([]);
    expect((await set(target, item.id, false)).status).toBe(200);
    expect(await stored(target)).toEqual([]);
    expect(await stored(target, target.leader)).toHaveLength(1);
    expect((await set(target, item.id, false)).status).toBe(404);
  });

  test('所属を失った対象の本人の印も解除できる', async () => {
    const target = await createTarget();
    const item = await task(target);
    expect((await set(target, item.id)).status).toBe(200);
    await createMembership(target.organization, target.otherWorkspace.id, target.member.userId!);
    const db = database(target);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: AT, left_on: '2026-11-09' })
          .where('workspace_id', '=', target.workspace.id)
          .where('user_id', '=', target.member.userId!),
      ),
    );
    expect(await list(target)).toEqual([]);
    expect((await set(target, item.id)).status).toBe(404);
    expect((await set(target, item.id, false)).status).toBe(200);
    expect(await stored(target)).toEqual([]);
  });

  test('閉じたワークスペースの読める対象は登録でき、再開したとき一覧に現れる', async () => {
    const target = await createTarget();
    const item = await task(target);
    const db = database(target);
    await db.run(
      db.statement((q) => q.updateTable('workspaces').set({ closed_at: AT }).where('id', '=', target.workspace.id)),
    );
    expect((await set(target, item.id)).status).toBe(200);
    expect(await list(target)).toEqual([]);
    expect(await stored(target)).toHaveLength(1);
    await db.run(
      db.statement((q) => q.updateTable('workspaces').set({ closed_at: null }).where('id', '=', target.workspace.id)),
    );
    expect((await list(target)).map((row) => row.target_id)).toEqual([item.id]);
  });

  test('別組織の対象を解除しても、その組織の本人の印に影響しない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const item = await task(other);
    expect((await set(other, item.id)).status).toBe(200);
    const before = await stored(other);
    expect((await set(target, item.id, false)).status).toBe(404);
    expect(await stored(other)).toEqual(before);
  });

  test('19件から同じ対象を同時に登録しても両方成功し、上限の1枠だけ使う', async () => {
    const target = await createTarget();
    for (let index = 0; index < 19; index++) expect((await set(target, (await task(target)).id)).status).toBe(200);
    const item = await task(target);
    const results = await Promise.all([set(target, item.id), set(target, item.id)]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    expect(await stored(target)).toHaveLength(20);
    expect((await list(target)).filter((row) => row.target_id === item.id)).toHaveLength(1);
  });

  test('20枠を埋めた削除済みの印を解除すると、新しい対象を登録できる', async () => {
    const target = await createTarget();
    let first = '';
    for (let index = 0; index < 20; index++) {
      const item = await task(target);
      first ||= item.id;
      expect((await set(target, item.id)).status).toBe(200);
    }
    const db = database(target);
    await db.run(db.statement((q) => q.updateTable('tasks').set({ deleted_at: AT }).where('id', '=', first)));
    const next = await task(target);
    expect((await set(target, next.id)).status).toBe(409);
    expect((await set(target, first, false)).status).toBe(200);
    expect((await set(target, next.id)).status).toBe(200);
    expect(await stored(target)).toHaveLength(20);
  });

  test('管理者を解除された人は、所属のない対象を再登録できず既存の印も見えない', async () => {
    const target = await createTarget();
    const item = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    expect((await set(target, item.id, true, target.admin)).status).toBe(200);
    // 組織へのアクセスを保ち、対象とは別の所属で入り直す。
    await createMembership(target.organization, target.workspace.id, target.admin.userId!);
    const db = database(target);
    await db.run(
      db.statement((q) => q.updateTable('users').set({ is_admin: 0 }).where('id', '=', target.admin.userId!)),
    );
    expect(await list(target, target.admin)).toEqual([]);
    expect((await set(target, item.id, true, target.admin)).status).toBe(404);
    expect((await set(target, item.id, false, target.admin)).status).toBe(200);
    expect(await stored(target, target.admin)).toEqual([]);
  });
});

test('登録のコミット直後に本人が解除しても、上限未満を favorite_limit と報告しない', async () => {
  const target = await createTarget();
  const item = await task(target);
  let removed = false;
  const racingEnv = envWithD1Hooks(env, {
    afterBatch: async (sqls) => {
      if (removed || !sqls.some((sql) => sql.startsWith('insert into "favorites"'))) return;
      removed = true;
      expect((await set(target, item.id, false)).status).toBe(200);
    },
  });
  const response = await post(app, favoriteSet, {
    slug: target.slug,
    token: target.member.token,
    env: racingEnv,
    body: { target_type: 'task', target_id: item.id, is_favorite: true },
  });
  expect(removed).toBe(true);
  expect(await stored(target)).toEqual([]);
  expect(response.status).toBe(200);
});
