// 上の帯は #1102 のタブバー追加後も維持する。名前、同じ行のアカウント、所属せず管理者の印を検査する。
import type { Page } from '@playwright/test';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { applyTheme, LAYOUT_THEMES, NARROW_VIEWPORT, signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});
async function measureFrame(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const item = document.querySelector<HTMLElement>('.breadcrumb [aria-current="page"]')!;
    const range = document.createRange();
    range.selectNodeContents(item);
    const crumb = document.querySelector('.breadcrumb')!.getBoundingClientRect();
    const account = document.querySelector('.account-menu-button')!.getBoundingClientRect();
    return {
      clipped: range.getBoundingClientRect().width > item.getBoundingClientRect().width + 0.01,
      gap: account.left - item.getBoundingClientRect().right,
      sameRow: Math.abs(account.top + account.height / 2 - (crumb.top + crumb.height / 2)) < 12,
    };
  });
}
for (const [path, name] of [
  [WORKSPACE, 'バックログ'],
  [`${WORKSPACE}/inbox`, '受信箱'],
  [`${WORKSPACE}/wiki`, 'Wiki'],
  [`${WORKSPACE}/settings`, '設定'],
] as const) {
  test(`390px の ${name} で今の画面の名前を読み、アカウントと同じ行に出す`, async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(path);
    await expect(page.locator('.breadcrumb [aria-current="page"]')).toHaveText(name);
    await page.waitForLoadState('networkidle');
    for (const theme of LAYOUT_THEMES) {
      await applyTheme(page, theme);
      const result = await measureFrame(page);
      expect(result.clipped, theme).toBe(false);
      expect(result.gap, theme).toBeGreaterThanOrEqual(0);
      expect(result.sameRow, theme).toBe(true);
    }
  });
}

test('390px で所属していない管理者がワークスペースを開いても、アカウントのボタンはパンくずの行に残る', async ({
  page,
}) => {
  // 所属していない管理者の印（.topbar の直接の子の .chip）は幅があり、パンくずの行に並べるとアカウントを2行目へ押し出す
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({ ...output, role: null }));
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  await expect(page.locator('.topbar > .chip')).toHaveText('所属せず管理者として開いています');
  await page.waitForLoadState('networkidle');
  const result = await measureFrame(page);
  expect(result.sameRow).toBe(true);
  expect(result.clipped).toBe(false);
  expect(result.gap).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('390px でアカウントのボタンはアバターと▾だけで、読み上げの名前に表示名を残す', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  const button = page.getByRole('button', { name: /ミナト.*アカウントのメニュー/ });
  await expect(button).toBeVisible();
  await expect(button.locator('.me-detail')).toBeHidden();
  await expect(button.locator('.avatar')).toBeVisible();
});

test('761px 以上では虫眼鏡を出さず、検索の欄と表示名を帯に出す', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(WORKSPACE);
  await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeVisible();
  await expect(page.locator('.nav-search-toggle')).toBeHidden();
  await expect(page.locator('.account-menu-button .me-detail')).toBeVisible();
});
