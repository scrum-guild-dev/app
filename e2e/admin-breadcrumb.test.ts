import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn } from './helpers.ts';

test('管理者でない人の管理画面ではパンくずに管理の名前を出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/admin');
  await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
  const breadcrumb = page.locator('.breadcrumb');
  await expect(breadcrumb).toContainText('あおば開発');
  await expect(breadcrumb).not.toContainText('組織の管理');
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText('あおば開発');
  await expectNoA11yViolationsInThemes(page, 'admin');
});

test('管理者の管理画面ではパンくずに管理の名前を出す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/aoba/admin');
  await expect(page.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();
  await expect(page.locator('.breadcrumb [aria-current="page"]')).toHaveText('組織の管理');
});
