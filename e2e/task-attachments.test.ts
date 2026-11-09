import type { Page } from '@playwright/test';
import { attachmentList, attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { taskCreate, taskUpdate } from '../src/shared/operations/task/index.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { membershipRoleUpdate } from '../src/shared/operations/workspace/membership-role-update.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

const MEMBER = '019a0000-0000-7000-8000-000000000302';
// 実際に描ける1ピクセルの PNG。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==',
  'base64',
);

// ナビゲーション完了と、クライアントが一覧を取得し終える時点は別。
// CI の短い expect 待ちの中に、初回の JS 読み込みと API の待ち時間を含めない。
function nextAttachmentList(page: Page) {
  return page.waitForResponse(
    (response) => response.url().endsWith(`/api/aoba/${attachmentList.name}`) && response.request().method() === 'POST',
  );
}
async function reloadAttachments(page: Page): Promise<void> {
  const response = nextAttachmentList(page);
  await page.reload();
  expect((await response).status()).toBe(200);
}

test('全種類の一覧、日時と容量、プレビュー、権限と削除後の本文を確かめる', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const headers = { Origin: new URL(baseURL).origin };
  await signIn(context, baseURL, 'admin');
  // ハルカをリーダーにして専用のワークスペースを作る。既存の seed のタスクを変更しない。
  const workspaceResponse = await page.request.post(`/api/aoba/${workspaceCreate.name}`, {
    headers,
    data: { name: '添付一覧の確認', timezone: 'Asia/Tokyo', leader_user_id: MEMBER },
  });
  expect(workspaceResponse.status()).toBe(200);
  const { workspace_id: workspaceId } = workspaceCreate.output.parse(await workspaceResponse.json());
  const created = await page.request.post(`/api/aoba/${taskCreate.name}`, {
    headers,
    data: { workspace_id: workspaceId, title: '添付ファイルを確認する' },
  });
  expect(created.status()).toBe(200);
  const task = taskCreate.output.parse(await created.json()).task;
  const taskUrl = `/aoba/w/${workspaceId}/tasks/${task.id}`;
  const initialList = nextAttachmentList(page);
  await page.goto(taskUrl);
  expect((await initialList).status()).toBe(200);
  const section = page.getByRole('region', { name: '添付ファイル', exact: true });
  await expect(section.locator('.file-row')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'ファイルを選ぶ', exact: true })).toBeVisible();

  const files: { id: string; file_name: string; created_at: string }[] = [];
  for (const [name, bytes] of [
    ['一覧の画像.png', PNG],
    ['一覧の録画.mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])],
    ['一覧の資料.txt', Buffer.from('添付一覧の資料')],
  ] as const) {
    const response = await page.request.post(`/api/aoba/${attachmentUpload.name}`, {
      headers: {
        ...headers,
        'X-Operation-Input': encodeURIComponent(JSON.stringify({ workspace_id: workspaceId, file_name: name })),
        'Content-Type': 'application/octet-stream',
      },
      data: bytes,
    });
    expect(response.status()).toBe(200);
    files.push(attachmentUpload.output.parse(await response.json()));
  }
  const imageUrl = `/api/aoba/attachments/${files[0].id}`;
  const saved = await page.request.post(`/api/aoba/${taskUpdate.name}`, {
    headers,
    data: {
      workspace_id: workspaceId,
      task_id: task.id,
      attachment_ids: files.map((file) => file.id),
      body_md: `![一覧の画像](${imageUrl})`,
    },
  });
  expect(saved.status()).toBe(200);
  await reloadAttachments(page);
  await expect(section.locator('.file-row')).toHaveCount(3);
  const imageRow = section.locator('.file-row', { hasText: '一覧の画像.png' });
  await expect(imageRow.locator('.file-meta')).toContainText(`${PNG.length}\u00a0B`);
  await expect(imageRow.locator('time')).toHaveAttribute('datetime', files[0].created_at);
  await expect(imageRow.locator('.file-meta')).toContainText('ミナト');
  await imageRow.getByRole('button', { name: '一覧の画像.png', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '一覧の画像.png', exact: true });
  await expect(preview.getByRole('img', { name: '一覧の画像.png' })).toBeVisible();
  await preview.getByRole('button', { name: '閉じる', exact: true }).last().click();
  await section.getByRole('button', { name: '一覧の録画.mp4', exact: true }).click();
  const videoPreview = page.getByRole('dialog', { name: '一覧の録画.mp4', exact: true });
  await expect(videoPreview).toBeVisible();
  await videoPreview.getByRole('button', { name: '閉じる', exact: true }).last().click();
  await expect(videoPreview.locator('video')).toHaveCount(0);
  const downloadEvent = page.waitForEvent('download');
  await section.getByRole('link', { name: '一覧の資料.txt', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('一覧の資料.txt');

  // 上げた人ではないリーダーには削除を出す。
  await signIn(context, baseURL, 'member');
  await reloadAttachments(page);
  await expect(imageRow.getByRole('button', { name: '一覧の画像.png を削除', exact: true })).toBeVisible();
  // 管理者がリーダーを一般メンバーに替えると、本人以外の削除は消える。
  await signIn(context, baseURL, 'admin');
  const role = await page.request.post(`/api/aoba/${membershipRoleUpdate.name}`, {
    headers,
    data: { workspace_id: workspaceId, user_id: MEMBER, role: 'member' },
  });
  expect(role.status()).toBe(200);
  await signIn(context, baseURL, 'member');
  await reloadAttachments(page);
  await expect(section.locator('.file-row')).toHaveCount(3);
  await expect(section.getByRole('button', { name: '一覧の画像.png を削除', exact: true })).toHaveCount(0);
  const list = await page.request.post(`/api/aoba/${attachmentList.name}`, {
    headers,
    data: { workspace_id: workspaceId, task_id: task.id },
  });
  expect(attachmentList.output.parse(await list.json()).attachments.every((file) => !file.deletable)).toBe(true);

  // アップロードした本人である管理者が削除する。画像は本文にも差し込まれている。
  await signIn(context, baseURL, 'admin');
  await reloadAttachments(page);
  await imageRow.getByRole('button', { name: '一覧の画像.png を削除', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '添付ファイルを削除しますか', exact: true });
  await expect(confirmation).toContainText('一覧の画像.png');
  await expect(confirmation).toContainText('戻せません');
  await expect(confirmation).toContainText('ファイルが見つかりません');
  await confirmation.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(section.locator('.file-row')).toHaveCount(2);
  await expect(section.getByRole('heading', { name: '添付ファイル', exact: true })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'ファイルが見つかりません' })).toBeVisible();
  expect((await page.request.get(imageUrl)).status()).toBe(404);
  // 小さい画面でも名前と操作がはみ出さない。
  for (const width of [320, 390, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(section.locator('.file-row')).toHaveCount(2);
    expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});
