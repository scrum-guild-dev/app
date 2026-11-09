// 通常状態と読み込み中の薄表示は同じ画面・内容・完了条件でaxeを測る。
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn, waitForSettled } from './helpers.ts';
import { a11yScreens } from './a11y-screen-fixtures.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

for (const { screen, path, prepare, ready } of a11yScreens) {
  test(`${screen}（${path}）に axe の違反が無い`, async ({ page }) => {
    await prepare?.(page);
    await page.goto(path);
    for (const locator of ready(page)) await expect(locator.first()).toBeVisible();
    await waitForSettled(page);
    await expectNoA11yViolationsInThemes(page, screen);
  });
}
