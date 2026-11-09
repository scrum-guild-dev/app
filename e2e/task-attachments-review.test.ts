import { attachmentList } from '../src/shared/operations/attachment/index.ts';
import { workspaceClose } from '../src/shared/operations/workspace/workspace-close.ts';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn } from './helpers.ts';
import { mockOperation } from './operations.ts';

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

test('長いファイル名でも狭いプレビューのダウンロード操作がはみ出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '長い添付名の確認');
  await addTaskRow(page, '長い名前の添付');
  const name = `${'a'.repeat(230)}.png`;
  await mockOperation(
    page,
    attachmentList,
    { slug: 'aoba' },
    {
      attachments: [
        {
          id: '019b0000-0000-7000-8000-000000000001',
          file_name: name,
          content_type: 'image/png',
          size_bytes: 1,
          created_at: '2026-11-01T00:00:00.000Z',
          uploaded_by: '019a0000-0000-7000-8000-000000000301',
          uploaded_by_name: 'ミナト',
          deletable: true,
        },
      ],
    },
  );
  await page
    .locator('.entry', { hasText: '長い名前の添付' })
    .getByRole('link', { name: '長い名前の添付', exact: true })
    .click();
  const section = page.getByRole('region', { name: '添付ファイル', exact: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await section.getByRole('button', { name, exact: true }).click();
    const preview = page.getByRole('dialog', { name, exact: true });
    const download = preview.getByRole('link', { name: `${name} をダウンロード`, exact: true });
    await expect(download).toHaveText('ダウンロード');
    expect(
      await preview.locator('.dialog-sheet').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await preview.getByRole('button', { name: '閉じる', exact: true }).last().click();
    await expect(preview).not.toBeVisible();
  }
});
