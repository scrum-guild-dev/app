import { expect, test } from './fixtures.ts';
import { applyTheme, LAYOUT_THEMES, signIn } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test('一覧の密度と詳細本文・入力欄の読みやすさを両立する（#1063）', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto(`${WORKSPACE}?task=019a0000-0000-7000-8000-000000000801`);
  const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
  await expect(drawer).toBeVisible();
  for (const theme of LAYOUT_THEMES) {
    await applyTheme(page, theme);
    await expect(page.locator('.nav-search-input')).toHaveCSS('font-size', '16px');
    await expect(drawer.locator('.props dt label').first()).toHaveCSS('font-size', '14px');
    await expect(page.locator('body')).toHaveCSS('font-size', '16px');
    await expect(page.locator('.entry-title').first()).toHaveCSS('font-size', '14px');
    await expect(drawer.locator('.edit-surface-body .doc-box').first()).toHaveCSS('font-size', '16px');
    await expect(drawer.locator('.field-label').first()).toHaveCSS('font-size', '14px');
    await expect(drawer.locator('.input:visible, .textarea:visible').first()).toHaveCSS('font-size', '16px');
    await expect(drawer.locator('.btn:not(.is-sm)').first()).toHaveCSS('font-size', '14px');
    // ルートの文字サイズを倍にして、固定pxへの置換や本文の欠けを検出する。
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect(drawer.locator('.edit-surface-body .doc-box').first()).toHaveCSS('font-size', '32px');
    const body = drawer.locator('.edit-surface-body .doc-box').first();
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('font-size');
    });
  }
});
