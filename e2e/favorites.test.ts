// #1086: 本番と同じ配信でお気に入りの API を通す。実行は CI に任せる。
import { z } from 'zod';
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { taskCreate, taskDelete, taskRestore } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { AOBA_CLIENT_WORKSPACE_ID, executeLocalD1 } from './local-d1.ts';

test('お気に入りの冪等な登録、本人限定、削除と復元、解除', async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const headers = { Origin: new URL(baseURL).origin };
  const workspace_id = AOBA_CLIENT_WORKSPACE_ID;
  await signIn(context, baseURL, 'member');
  const created = await page.request.post(`/api/aoba/${taskCreate.name}`, {
    headers,
    data: { workspace_id, title: `お気に入りの確認 ${crypto.randomUUID()}` },
  });
  expect(created.status()).toBe(200);
  const { task } = taskCreate.output.parse(await created.json());
  // 後片付けの SQL へ埋め込む値は UUID に限定する。
  const taskId = z.uuid().parse(task.id);
  const target = { target_type: 'task', target_id: task.id };
  const read = async () => {
    const response = await page.request.post(`/api/aoba/${favoriteList.name}`, { headers, data: {} });
    expect(response.status()).toBe(200);
    return favoriteList.output.parse(await response.json()).favorites.filter((row) => row.target_id === task.id);
  };
  const set = (is_favorite: boolean) =>
    page.request.post(`/api/aoba/${favoriteSet.name}`, { headers, data: { ...target, is_favorite } });
  const taskInput = { workspace_id, task_id: task.id };
  let deleted = false;
  try {
    expect((await set(true)).status()).toBe(200);
    const first = await read();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ...target, workspace_id, title: task.title });
    expect((await set(true)).status()).toBe(200);
    expect(await read()).toEqual(first);
    await signIn(context, baseURL, 'admin');
    expect(await read()).toEqual([]);
    await signIn(context, baseURL, 'member');
    expect((await page.request.post(`/api/aoba/${taskDelete.name}`, { headers, data: taskInput })).status()).toBe(200);
    deleted = true;
    expect(await read()).toEqual([]);
    expect((await page.request.post(`/api/aoba/${taskRestore.name}`, { headers, data: taskInput })).status()).toBe(200);
    deleted = false;
    expect(await read()).toEqual(first);
    expect((await set(false)).status()).toBe(200);
    expect((await set(false)).status()).toBe(200);
    expect(await read()).toEqual([]);
  } finally {
    try {
      await signIn(context, baseURL, 'member');
      expect((await set(false)).status()).toBe(200);
      if (!deleted)
        expect((await page.request.post(`/api/aoba/${taskDelete.name}`, { headers, data: taskInput })).status()).toBe(
          200,
        );
    } finally {
      // 他のテストの題の接頭辞を共有せず、このテストが作った1件だけを子から消す。
      const createdTask = `SELECT id FROM tasks WHERE id = '${taskId}' AND workspace_id = '${workspace_id}'`;
      await executeLocalD1([
        `DELETE FROM favorites WHERE task_id IN (${createdTask});`,
        `DELETE FROM change_logs WHERE workspace_id = '${workspace_id}' AND entity_type = 'task' AND entity_id IN (${createdTask});`,
        `DELETE FROM tasks WHERE id IN (${createdTask});`,
      ]);
    }
  }
});
