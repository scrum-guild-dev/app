import { taskCreate } from '../src/shared/operations/task/task-create.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

test('作成時に送った本文をタスクの詳細で読める', async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const headers = { Origin: new URL(baseURL).origin };
  const workspace = await page.request.post(`/api/aoba/${workspaceCreate.name}`, {
    headers,
    data: {
      name: '作成時の本文を確かめる',
      timezone: 'Asia/Tokyo',
      // 一般のメンバーの既定のワークスペースを変えないよう、管理者をリーダーにする。
      leader_user_id: '019a0000-0000-7000-8000-000000000301',
    },
  });
  expect(workspace.status()).toBe(200);
  const { workspace_id: workspaceId } = workspaceCreate.output.parse(await workspace.json());
  const created = await page.request.post(`/api/aoba/${taskCreate.name}`, {
    headers,
    data: {
      workspace_id: workspaceId,
      title: '本文付きで起票する',
      body_md: '\r\n## 手順\r\n- 見積もりを確かめる  \r\n',
    },
  });
  expect(created.status()).toBe(200);
  const { task } = taskCreate.output.parse(await created.json());
  await page.goto(`/aoba/w/${workspaceId}/tasks/${task.id}`);
  const body = page.locator('.doc-box');
  await expect(body.getByRole('heading', { name: '手順' })).toBeVisible();
  await expect(body.getByRole('listitem')).toHaveText('見積もりを確かめる');
  await page.reload();
  await expect(body.getByRole('listitem')).toHaveText('見積もりを確かめる');
});
