// #1086: 本番と同じ配信でお気に入りの API を通す。実行は CI に任せる。
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { taskCreate, taskDelete, taskRestore } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

test('お気に入りの冪等な登録、本人限定、削除と復元、解除', async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const headers = { Origin: new URL(baseURL).origin };
  const workspace_id = '019a0000-0000-7000-8000-000000000401';
  await signIn(context, baseURL, 'member');
  const created = await page.request.post(`/api/aoba/${taskCreate.name}`, {
    headers,
    data: { workspace_id, title: `お気に入りの確認 ${crypto.randomUUID()}` },
  });
  expect(created.status()).toBe(200);
  const { task } = taskCreate.output.parse(await created.json());
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
    await signIn(context, baseURL, 'member');
    expect((await set(false)).status()).toBe(200);
    if (!deleted)
      expect((await page.request.post(`/api/aoba/${taskDelete.name}`, { headers, data: taskInput })).status()).toBe(
        200,
      );
  }
});
