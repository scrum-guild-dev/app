// スマホの大きな見出しと丸い入口（#1103）。E2E は CI で実行する。
import type { Page } from '@playwright/test';
import { orgWikiTree } from '../src/shared/operations/wiki/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { applyTheme, LAYOUT_THEMES, NARROW_VIEWPORT, signIn } from './helpers.ts';
import { failOperation, rewriteOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});
async function measureFrame(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const tools = document.querySelector('.mobile-page-tools')!;
    const row = tools.closest('.page-head-row')!;
    const title = row.querySelector<HTMLElement>('.page-title')!;
    const titleBox = title.getBoundingClientRect();
    const search = tools.querySelector('.nav-search-toggle')!.getBoundingClientRect();
    const account = tools.querySelector('.account-menu-button')!.getBoundingClientRect();
    return {
      clipped: title.scrollWidth > title.clientWidth,
      size: parseFloat(getComputedStyle(title).fontSize),
      gap: search.left - titleBox.right,
      sameRow: Math.abs(account.top - titleBox.top) < 1,
      buttons: [search, account].map((box) => ({ width: box.width, height: box.height })),
    };
  });
}
for (const [path, name] of [
  ['/aoba', '今日やること'],
  ['/aoba/admin', '組織の管理'],
  [WORKSPACE, 'バックログ'],
  [`${WORKSPACE}/inbox`, '受信箱'],
  [`${WORKSPACE}/wiki`, 'Wiki'],
  [`${WORKSPACE}/settings`, '設定'],
] as const) {
  test(`390px の ${name} で上の帯を出さず、大きな見出しと丸ボタンを同じ行に出す`, async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(path);
    await expect(page.locator('.mobile-page-tools')).toHaveCount(1);
    await expect(page.locator('.topbar')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'パンくず' })).toHaveCount(0);
    await expect(page.locator('.page-title')).toHaveText(name);
    await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeHidden();
    for (const theme of LAYOUT_THEMES) {
      await applyTheme(page, theme);
      const result = await measureFrame(page);
      expect(result.clipped, theme).toBe(false);
      expect(result.size, theme).toBeGreaterThanOrEqual(32);
      expect(result.gap, theme).toBeGreaterThanOrEqual(0);
      expect(result.sameRow, theme).toBe(true);
      for (const box of result.buttons) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
  });
}

test('390px で所属していない管理者の印は見出しの外に残り、丸ボタンと重ならない', async ({ page }) => {
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({ ...output, role: null }));
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  await expect(page.getByText('所属せず管理者として開いています', { exact: true })).toBeVisible();
  await expect(page.locator('.mobile-page-tools > .chip')).toHaveCount(0);
  const chip = await page.getByText('所属せず管理者として開いています', { exact: true }).boundingBox();
  expect(chip).not.toBeNull();
  expect(chip!.x).toBeGreaterThanOrEqual(16);
  expect(chip!.x + chip!.width).toBeLessThanOrEqual(NARROW_VIEWPORT.width - 16);
  await expect(page.locator('.mobile-page-tools')).toHaveCount(1);
  const result = await measureFrame(page);
  expect(result.sameRow).toBe(true);
  expect(result.clipped).toBe(false);
  expect(result.gap).toBeGreaterThanOrEqual(0);
});

test('390px の長い画面名は丸ボタンの手前で折り返す', async ({ page }) => {
  const name = 'W'.repeat(50);
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/aoba');
  await expect(page.locator('.page-head .mobile-page-tools')).toHaveCount(1);
  // 画面の文言は変えず、部品に長い題が渡されたときの折り返しを測る。
  await page.locator('.page-title').evaluate((title, value) => {
    title.textContent = value;
  }, name);
  for (const theme of LAYOUT_THEMES) {
    await applyTheme(page, theme);
    const result = await measureFrame(page);
    expect(result.clipped).toBe(false);
    expect(result.gap).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('PageHead のない詳細では長いワークスペース名を出し、一覧へ移ると見出しの入口を1つに保つ', async ({ page }) => {
  const name = 'W'.repeat(50);
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    name,
  }));
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(`${WORKSPACE}/tasks/019a0000-0000-7000-8000-000000000701`);
  await expect(page.locator('.mobile-page-head .page-title')).toHaveText(name);
  await expect(page.locator('.mobile-page-tools')).toHaveCount(1);
  expect((await measureFrame(page)).gap).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', { name: '画面とタスクを探す' }).click();
  await page.getByRole('combobox', { name: '画面とタスクを探す' }).fill('今日');
  await page.getByRole('option', { name: '今日やること', exact: true }).click();
  await expect(page).toHaveURL('/aoba');
  await expect(page.locator('.mobile-page-head')).toHaveCount(0);
  await expect(page.locator('.page-head .mobile-page-tools')).toHaveCount(1);
});

test('390px でアカウントは丸いアバターだけにし、読み上げ名に表示名を残す', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  const button = page.getByRole('button', { name: /ミナト.*アカウントのメニュー/ });
  await expect(button).toBeVisible();
  await expect(button.locator('.me-detail')).toBeHidden();
  await expect(button.locator('.avatar')).toBeVisible();
  await expect(button.locator(':scope > .ico')).toBeHidden();
  await expect(button).toHaveCSS('border-radius', '50%');
});

for (const width of [761, 1280]) {
  test(`${width}px では検索の欄と表示名を帯に出し、スマホ幅との切り替えでも入口を重複させない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(WORKSPACE);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeVisible();
    await expect(page.locator('.nav-search-toggle')).toBeHidden();
    await expect(page.locator('.account-menu-button .me-detail')).toBeVisible();
    await page.setViewportSize(NARROW_VIEWPORT);
    await expect(page.locator('.topbar')).toHaveCount(0);
    await expect(page.locator('.mobile-page-tools')).toHaveCount(1);
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator('.mobile-page-tools')).toHaveCount(0);
    await expect(page.locator('.account-menu-button')).toHaveCount(1);
  });
}

test('Wiki の読み込み失敗で見出しが複数あっても、検索とアカウントは1組だけになる', async ({ page }) => {
  await failOperation(page, orgWikiTree, { slug: 'aoba' }, 500, 'internal');
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/aoba/wiki');
  await expect(page.getByText('読み込めませんでした', { exact: true })).toBeVisible();
  await expect(page.locator('.page-head')).toHaveCount(2);
  await expect(page.locator('.mobile-page-tools')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeFocused();
});

for (const width of [320, 390]) {
  for (const [path, title] of [
    ['/aoba/me', 'マイプロフィール'],
    ['/aoba/wiki', 'Wiki'],
  ]) {
    test(`${width}px の ${title} で、折り返した見出しと入口が重ならず、一覧は入口の直下で開く`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await expect(page.locator('.page-title')).toHaveText(title);
      if (path === '/aoba/wiki') await expect(page.locator('.page-actions')).toBeVisible();
      await expect(page.locator('.page-head .mobile-page-tools')).toHaveCount(1);
      const measure = await measureFrame(page);
      expect(measure.clipped).toBe(false);
      expect(measure.gap).toBeGreaterThanOrEqual(0);
      const account = page.getByRole('button', { name: /アカウントのメニュー$/ });
      await account.click();
      await expect(account).toHaveAttribute('aria-expanded', 'true');
      const row = await page.locator('.page-title-row').boundingBox();
      const list = await page.locator('.account-menu-list').boundingBox();
      expect(row).not.toBeNull();
      expect(list).not.toBeNull();
      expect(list!.y - row!.y - row!.height).toBeGreaterThanOrEqual(0);
      expect(list!.y - row!.y - row!.height).toBeLessThanOrEqual(8);
      await page.keyboard.press('Escape');
      const search = page.getByRole('button', { name: '画面とタスクを探す' });
      await search.click();
      await expect(search).toHaveAttribute('aria-expanded', 'true');
      const box = await page.getByRole('search', { name: '画面とタスクを探す' }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y - row!.y - row!.height).toBeGreaterThanOrEqual(0);
      expect(box!.y - row!.y - row!.height).toBeLessThanOrEqual(8);
    });
  }
}
