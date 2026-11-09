import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, expectNoA11yViolationsInThemes, signIn } from './helpers.ts';

test('アカウントのメニューは短く開き、閉じると即座に消え、動きを減らす設定では動かない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/aoba');
  const button = page.locator('.account-menu-button');
  const menu = page.locator('.account-menu-list');
  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    await button.click();
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('transition-duration', '0.12s, 0.12s');
    await expect(menu).toHaveCSS('translate', /^0px(?: 0px)?$/);
    await button.click();
    await expect(menu).toBeHidden();
    expect(await menu.evaluate((element) => element.getAnimations().length)).toBe(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await button.click();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('transition-duration', '0s');
  expect(await menu.evaluate((element) => element.getAnimations().length)).toBe(0);
  await expectNoA11yViolationsInThemes(page, 'today');
});
