import { attachmentList } from '../src/shared/operations/attachment/index.ts';
import { workspaceClose } from '../src/shared/operations/workspace/workspace-close.ts';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn } from './helpers.ts';

test('閉じたワークスペースで添付がないタスクにも空の理由を表示する', async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '添付の読み取り専用の確認');
  await addTaskRow(page, '添付がないタスク');
  await page
    .locator('.entry', { hasText: '添付がないタスク' })
    .getByRole('link', { name: '添付がないタスク', exact: true })
    .click();
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  const response = await page.request.post(`/api/aoba/${workspaceClose.name}`, {
    headers: { Origin: new URL(baseURL).origin },
    data: { workspace_id: workspaceId },
  });
  expect(response.status()).toBe(200);
  const listed = page.waitForResponse((result) => result.url().endsWith(`/api/aoba/${attachmentList.name}`));
  await page.reload();
  expect((await listed).status()).toBe(200);
  const section = page.getByRole('region', { name: '添付ファイル', exact: true });
  await expect(section.getByRole('status')).toHaveText('添付ファイルはありません。');
  await expect(section.getByRole('button', { name: 'ファイルを選ぶ', exact: true })).toHaveCount(0);
});
