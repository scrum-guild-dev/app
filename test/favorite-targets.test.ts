import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { AT, createStory, createTask, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
async function list(target: Target) {
  const response = await post(app, favoriteList, { slug: target.slug, token: target.member.token, body: {} });
  expect(response.status).toBe(200);
  return favoriteList.output.parse(await response.json()).favorites;
}
async function set(target: Target, target_type: 'task' | 'story' | 'wiki_page', target_id: string, value = true) {
  const response = await post(app, favoriteSet, {
    slug: target.slug,
    token: target.member.token,
    body: { target_type, target_id, is_favorite: value },
  });
  expect(response.status).toBe(200);
}

test('異なる種類で同じIDでも題と解除先を混同しない', async () => {
  const target = await createTarget();
  const id = uuidv7();
  await createTask(target.organization, target.workspace.id, target.admin.userId!, { id, title: 'タスクの題' });
  await createStory(target.organization, target.workspace.id, target.admin.userId!, { id, title: 'ストーリーの題' });
  await set(target, 'task', id);
  await set(target, 'story', id);
  expect(await list(target)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target_type: 'task', target_id: id, title: 'タスクの題' }),
      expect.objectContaining({ target_type: 'story', target_id: id, title: 'ストーリーの題' }),
    ]),
  );
  expect(await list(target)).toHaveLength(2);
  await set(target, 'story', id, false);
  expect(await list(target)).toEqual([expect.objectContaining({ target_type: 'task', title: 'タスクの題' })]);
});

test('登録後に題が変わると一覧の題だけ更新し、印のIDと登録日時は保つ', async () => {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, { title: '変更前' });
  await set(target, 'task', task.id);
  const [before] = await list(target);
  const db = orgDb(env, target.organization.verified);
  await db.run(db.statement((q) => q.updateTable('tasks').set({ title: '変更後 ✨' }).where('id', '=', task.id)));
  expect(await list(target)).toEqual([{ ...before, title: '変更後 ✨' }]);
});

test('ワークスペースを持たない組織Wikiも削除で隠れ、復元で同じ印が戻る', async () => {
  const target = await createTarget();
  const id = uuidv7();
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q.insertInto('wiki_pages').values({
        id,
        organization_id: target.organization.id,
        workspace_id: null,
        parent_id: null,
        title: '組織Wiki',
        body_md: '本文',
        version: 1,
        position: 'a0',
        created_by: target.admin.userId!,
        updated_by: target.admin.userId!,
        created_at: AT,
        updated_at: AT,
        deleted_at: null,
        deleted_by: null,
      }),
    ),
  );
  await set(target, 'wiki_page', id);
  const before = await list(target);
  expect(before).toEqual([expect.objectContaining({ target_id: id, workspace_id: null })]);
  await db.run(
    db.statement((q) =>
      q.updateTable('wiki_pages').set({ deleted_at: AT, deleted_by: target.admin.userId! }).where('id', '=', id),
    ),
  );
  expect(await list(target)).toEqual([]);
  await db.run(
    db.statement((q) => q.updateTable('wiki_pages').set({ deleted_at: null, deleted_by: null }).where('id', '=', id)),
  );
  expect(await list(target)).toEqual(before);
});
