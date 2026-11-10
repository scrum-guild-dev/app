// 容量の表示と警告の境界。容量の書き込み・同時要求の拒否は API テストで確かめる。
// E2E は通常・開発・繰り返しの CI で実行する。
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn } from './helpers.ts';
import { rewriteOperation, routeOperation } from './operations.ts';

const GIB = 1024 ** 3;

test('同じ組織の枠を保って管理画面へ移っても、容量は移った時点で読み直す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let used = GIB;
  let reads = 0;
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => {
    reads++;
    return {
      ...output,
      storage: { used_bytes: used, quota_bytes: 10 * GIB, organization_wiki_bytes: 0, workspaces: [] },
    };
  });
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
  await expect(page.getByRole('button', { name: /アカウントのメニュー$/ })).toBeVisible();
  const before = reads;
  expect(before).toBeGreaterThan(0);
  // 添付や Wiki の書き込みの後のサーバーの使用量を再現する。枠の保持済みデータは1GBのまま。
  used = 9 * GIB;
  await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
  await page.locator('.account-menu-list').getByRole('link', { name: '組織の管理' }).click();
  await expect(page).toHaveURL(/\/aoba\/admin$/);
  const section = page.getByRole('region', { name: '添付ファイルと Wiki の容量' });
  await expect(section).toContainText(`${used.toLocaleString('ja-JP')} バイト使用中`);
  await expect(section).toContainText('上限の80%を超えています');
  expect(reads).toBeGreaterThan(before);
});

test('管理画面での容量の読み直しが失敗したら、枠の古い値を出さず再試行できる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let failing = false;
  let used = GIB;
  await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
    if (failing) return call.fail(500, 'internal');
    const output = await call.fetch();
    await call.fulfill({
      ...output,
      storage: { used_bytes: used, quota_bytes: 10 * GIB, organization_wiki_bytes: 0, workspaces: [] },
    });
  });
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
  await expect(page.getByRole('button', { name: /アカウントのメニュー$/ })).toBeVisible();
  failing = true;
  used = 9 * GIB;
  await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
  await page.locator('.account-menu-list').getByRole('link', { name: '組織の管理' }).click();
  const section = page.getByRole('region', { name: '添付ファイルと Wiki の容量' });
  await expect(section).toContainText('容量を読み込めませんでした');
  await expect(section).not.toContainText('バイト使用中');
  failing = false;
  await section.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(section).toContainText(`${used.toLocaleString('ja-JP')} バイト使用中`);
  await expect(section.getByRole('button', { name: 'もう一度試す' })).toHaveCount(0);
});

for (const used of [0, 8, 9, 10, 12]) {
  test(`管理者の容量内訳と ${used} / 10 GB の警告を出す`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
      ...output,
      storage: {
        used_bytes: used * GIB,
        quota_bytes: 10 * GIB,
        organization_wiki_bytes: used === 0 ? 0 : GIB,
        workspaces: [
          { id: 'storage-aoba', name: 'あおばの添付ファイルと Wiki', used_bytes: Math.max(0, used - 1) * GIB },
          { id: 'storage-closed', name: '終了したワークスペース', used_bytes: 0 },
        ],
      },
    }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/aoba/admin');
    const section = page.getByRole('region', { name: '添付ファイルと Wiki の容量' });
    await expect(section).toBeVisible();
    await expect(section).toContainText(`${(used * GIB).toLocaleString('ja-JP')} バイト使用中`);
    await expect(section.getByRole('row')).toHaveCount(4);
    await expect(section).toContainText('組織の Wiki');
    await expect(section).toContainText('終了したワークスペース');
    await expect(section.locator('.callout')).toHaveCount(used > 8 ? 1 : 0);
    if (used >= 10) {
      await expect(section.locator('.callout')).toContainText('新しく添付できません');
      await expect(section.locator('.callout')).toContainText('上げた人かワークスペースのリーダー');
      await expect(section.locator('.meter-bar > span')).toHaveAttribute('style', /width:\s*100%/);
    } else if (used > 8) {
      await expect(section.locator('.callout')).toContainText('上限の80%を超えています');
    }
    if (used === 9) await expectNoA11yViolationsInThemes(page, 'admin');
  });
}

test('管理者でない人には管理の容量内訳を出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/admin');
  await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
  await expect(page.getByRole('region', { name: '添付ファイルと Wiki の容量' })).toHaveCount(0);
});

test('1MB未満の Wiki と添付の内訳も、0MBに丸めずバイト数で出す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    storage: {
      used_bytes: 37,
      quota_bytes: GIB,
      organization_wiki_bytes: 16,
      workspaces: [{ id: 'tiny-workspace', name: '小さな Wiki', used_bytes: 21 }],
    },
  }));
  await page.goto('/aoba/admin');
  const section = page.getByRole('region', { name: '添付ファイルと Wiki の容量' });
  await expect(section.getByRole('row').filter({ hasText: '組織の Wiki' })).toContainText('16 B');
  await expect(section.getByRole('row').filter({ hasText: '小さな Wiki' })).toContainText('21 B');
  await expect(section).toContainText('37 バイト使用中');
});
