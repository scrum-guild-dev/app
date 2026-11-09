import { attachmentList } from '../src/shared/operations/attachment/index.ts';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';

test('狭い画面の一覧再試行も44pxの操作範囲を持つ', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '添付の再試行の操作範囲');
  await addTaskRow(page, '添付の再試行');
  let calls = 0;
  await routeOperation(page, attachmentList, { slug: 'aoba' }, async (call) => {
    calls++;
    if (calls === 1) await call.fail(500, 'internal');
    else await call.fulfill({ attachments: [] });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page
    .locator('.entry', { hasText: '添付の再試行' })
    .getByRole('link', { name: '添付の再試行', exact: true })
    .click();
  const section = page.getByRole('region', { name: '添付ファイル', exact: true });
  const retry = section.getByRole('button', { name: 'もう一度試す', exact: true });
  await expect(retry).toBeVisible();
  const hit = await retry.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return { width: parseFloat(style.width), height: parseFloat(style.height) };
  });
  expect(hit.width).toBeGreaterThanOrEqual(44);
  expect(hit.height).toBeGreaterThanOrEqual(44);
  await retry.click();
  await expect(section.getByRole('button', { name: 'ファイルを選ぶ', exact: true })).toBeVisible();
  await expect(section.getByRole('alert')).toHaveCount(0);
  expect(calls).toBe(2);
});
