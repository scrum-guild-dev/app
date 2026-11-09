import { attachmentList } from '../src/shared/operations/attachment/index.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';

const AT = '2026-11-01T00:00:00.000Z';

test('添付の続きを読み、失敗しても表示済みの行を残して同じカーソルから再試行する', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await createWorkspace(page, '添付のページ分割');
  await addTaskRow(page, '添付の続きを確認する');
  const files: OutputOf<typeof attachmentList>['attachments'] = Array.from({ length: 51 }, (_, index) => ({
    id: `019b0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    file_name: `資料${index + 1}.txt`,
    content_type: 'application/octet-stream',
    size_bytes: 1,
    created_at: AT,
    uploaded_by: '019a0000-0000-7000-8000-000000000301',
    uploaded_by_name: 'ミナト',
    deletable: true,
  }));
  const cursor = { created_at: AT, id: files[49]!.id };
  let subsequentCalls = 0;
  await routeOperation(page, attachmentList, { slug: 'aoba' }, async (call) => {
    if (call.input.after === undefined) {
      await call.fulfill({ attachments: files.slice(0, 50), next_cursor: cursor });
      return;
    }
    expect(call.input.after).toEqual(cursor);
    subsequentCalls++;
    if (subsequentCalls === 1) await call.fail(500, 'internal');
    // 境界の行が重なった応答でも、表示済みの ID は重ねて描かない。
    else await call.fulfill({ attachments: files.slice(49) });
  });
  await page
    .locator('.entry', { hasText: '添付の続きを確認する' })
    .getByRole('link', { name: '添付の続きを確認する', exact: true })
    .click();
  const section = page.getByRole('region', { name: '添付ファイル', exact: true });
  await expect(section.locator('.file-row')).toHaveCount(50);
  await expect(section.getByRole('link', { name: '資料51.txt', exact: true })).toHaveCount(0);
  await section.getByRole('button', { name: 'さらに読む', exact: true }).click();
  await expect(section.getByRole('alert')).toBeVisible();
  await expect(section.locator('.file-row')).toHaveCount(50);
  await section.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(section.locator('.file-row')).toHaveCount(51);
  await expect(section.getByRole('link', { name: '資料51.txt', exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'さらに読む', exact: true })).toHaveCount(0);
  expect(subsequentCalls).toBe(2);
});
