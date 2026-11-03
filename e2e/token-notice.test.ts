import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled, watchViolations } from './helpers.ts';
import { tokenNotice, tokenNoticeSeen } from '../src/shared/operations/session/token-notice.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

const label = 'API トークンの発行の知らせ';

test('別端末の発行を組織の画面に出し、取り消した発行も残し、「確かめた」を押すとこの端末で消える', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await signIn(context, baseURL, 'tokenNoticeIssuer');
  const viewer = await browser.newContext({ baseURL });
  try {
    await signIn(viewer, baseURL, 'tokenNoticeViewer');
    const other = await viewer.newPage();
    await page.goto('/kaze/me');
    await other.goto('/kaze/me');
    const name = `発行の知らせ ${Date.now().toString(36)}`;
    const section = page.getByRole('region', { name: 'API トークン', exact: true });
    await section.getByLabel('名前', { exact: true }).fill(name);
    await section.getByRole('button', { name: '発行する' }).click();
    const issued = page.getByRole('dialog', { name: 'API トークンを発行しました' });
    await expect(issued).toBeVisible();
    await issued.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
    await page.reload();
    await waitForSettled(page);
    await expect(page.getByRole('region', { name: label })).toHaveCount(0);

    // 発行後すぐ取り消しても、別端末には発行が残る。
    const row = section.getByRole('table').locator('tbody tr', { hasText: name });
    await row.getByRole('button', { name: `API トークン「${name}」を取り消す` }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取り消す', exact: true }).click();
    await expect(row).toHaveCount(0);
    await other.reload();
    const notice = other.getByRole('region', { name: label });
    await expect(notice).toContainText(name);
    await expect(notice).toContainText('取り消し済み');
    await expect(notice.getByRole('link', { name: '設定を開く' })).toHaveAttribute('href', '/kaze/me#api-tokens');
    await notice.getByRole('button', { name: '確かめた', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await other.reload();
    await waitForSettled(other);
    await expect(notice).toHaveCount(0);
  } finally {
    await viewer.close();
  }
});

const latest = {
  name: '長い名前の確かめ'.repeat(10),
  scope: 'write' as const,
  created_at: '2026-11-04T01:30:00.000Z',
  revoked: false,
};
for (const width of [320, 390, 1024, 1280]) {
  test(`${width}pxで長い名前を折り返し、帯と操作が横にはみ出さない`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, tokenNotice, { count: 2, latest });
    await page.setViewportSize({ width, height: 900 });
    const collect = await watchViolations(page);
    await page.goto('/aoba/me');
    const notice = page.getByRole('region', { name: label });
    await expect(notice).toContainText(latest.name);
    for (const role of ['button', 'link'] as const) {
      const box = await notice.getByRole(role).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(await collect()).toEqual([]);
  });
}

test('確認に失敗したら帯と再試行の操作を残す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, tokenNotice, { count: 2, latest });
  await failOperation(page, tokenNoticeSeen, 500, 'internal');
  await page.goto('/aoba/me');
  const notice = page.getByRole('region', { name: label });
  await notice.getByRole('button', { name: '確かめた', exact: true }).click();
  await expect(notice.getByRole('alert')).toHaveText(
    '確認を保存できませんでした。もう一度「確かめた」を押してください。',
  );
  await expect(notice).toContainText(latest.name);
});

test('表示した日時だけを確認に送り、その間に増えた発行を帯に残す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let confirmed = false;
  const newer = { ...latest, name: '後から増えた発行', created_at: '2026-11-04T01:31:00.000Z' };
  await routeOperation(page, tokenNotice, async (call) => {
    await call.fulfill({ count: 1, latest: confirmed ? newer : latest });
  });
  await routeOperation(page, tokenNoticeSeen, async (call) => {
    expect(call.input.created_at).toBe(latest.created_at);
    confirmed = true;
    await call.fulfill({});
  });
  await page.goto('/aoba/me');
  const notice = page.getByRole('region', { name: label });
  await expect(notice).toContainText(latest.name);
  await notice.getByRole('button', { name: '確かめた', exact: true }).click();
  await expect(notice).toContainText(newer.name);
});
