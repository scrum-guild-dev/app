import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, expectNoA11yViolationsInThemes, signIn } from './helpers.ts';

test('切り替えとアカウントのメニューは短く開き、閉じると即座に消え、動きを減らす設定では動かない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
  for (const [buttonSelector, menuSelector] of [
    ['.org-menu-button', '.org-menu-list'],
    ['.ws-menu-button', '.ws-menu-list'],
    ['.account-menu-button', '.account-menu-list:not(.row-menu-list)'],
  ]) {
    const button = page.locator(buttonSelector);
    const menu = page.locator(menuSelector);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await menu.evaluate((element) => {
      element.addEventListener('transitionrun', (event) => {
        const transition = event as TransitionEvent;
        if (transition.target === element) element.setAttribute(`data-enter-${transition.propertyName}`, 'true');
      });
    });
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      await menu.evaluate((element) => {
        element.removeAttribute('data-enter-opacity');
        element.removeAttribute('data-enter-translate');
      });
      await button.click();
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('data-enter-opacity', 'true');
      await expect(menu).toHaveAttribute('data-enter-translate', 'true');
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
    await button.click();
  }
  // 同じ見た目の一覧を共有する行メニューには入場の動きを足さない。
  await page.locator('.row-menu-btn').first().click();
  const rowMenu = page.locator('.row-menu-list:visible').first();
  await expect(rowMenu).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(rowMenu).toHaveCSS('transition-duration', '0s');
  await page.keyboard.press('Escape');
  await expectNoA11yViolationsInThemes(page, 'backlog');
});
