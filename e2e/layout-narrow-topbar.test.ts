// スマホの枠（#1102）。E2E は CI で実行する。
import { favoriteList } from '../src/shared/operations/favorite.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { applyTheme, LAYOUT_THEMES, NARROW_VIEWPORT, signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize(NARROW_VIEWPORT);
});

for (const theme of LAYOUT_THEMES) {
  test(`${theme}: 下のタブで移り、現在地と44px以上の押せる範囲を示す`, async ({ page }) => {
    await page.goto('/aoba');
    await applyTheme(page, theme);
    const tabs = page.getByRole('navigation', { name: 'よく使う画面' });
    await expect(page.locator('.binding')).toHaveCount(0);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(tabs.getByRole('link')).toHaveCount(3);
    for (const item of await tabs.locator('a, button').all()) {
      const box = await item.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(tabs.getByRole('link', { name: '今日やること', exact: true })).toHaveAttribute('aria-current', 'page');
    const mark = await tabs.locator('[aria-current="page"]').evaluate((element) => {
      const marker = getComputedStyle(element, '::after');
      const luminance = (color: string) =>
        color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .reduce((sum, value, index) => {
            const channel = value / 255;
            return (
              sum +
              (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
                [0.2126, 0.7152, 0.0722][index]
            );
          }, 0);
      const fg = luminance(marker.backgroundColor);
      const bg = luminance(getComputedStyle(element).backgroundColor);
      return {
        content: marker.content,
        width: parseFloat(marker.width),
        contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
      };
    });
    expect(mark.content).not.toBe('none');
    expect(mark.width).toBeGreaterThan(0);
    expect(mark.contrast).toBeGreaterThanOrEqual(3);
    await tabs.getByRole('link', { name: 'お気に入り', exact: true }).click();
    await expect(page).toHaveURL(/\/aoba\/favorites$/);
    await expect(tabs.getByRole('link', { name: 'お気に入り', exact: true })).toHaveAttribute('aria-current', 'page');
    await tabs.getByRole('link', { name: 'バックログ', exact: true }).click();
    await expect(page).toHaveURL(WORKSPACE);
    await expect(tabs.getByRole('link', { name: 'バックログ', exact: true })).toHaveAttribute('aria-current', 'page');
    await tabs.getByRole('link', { name: '今日やること', exact: true }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    // 最後に本文の末尾を画面内へ送り、固定タブの上に余白が残ることを測る。
    await page.locator('#content').evaluate((content) => {
      const last = document.createElement('p');
      last.textContent = '本文の最後の行';
      content.append(last);
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    const gap = await page.evaluate(() => {
      const content = document.getElementById('content')!;
      const last = content.lastElementChild!.getBoundingClientRect();
      const tabs = document.querySelector('.mobile-tabs')!.getBoundingClientRect();
      return tabs.top - last.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('浮きメニューに全項目と切り替えがあり、Esc・外・リンクで閉じる', async ({ page }) => {
  await rewriteOperation(page, favoriteList, { slug: 'aoba' }, () => ({
    marks: [],
    favorites: [
      {
        id: 'mobile-favorite',
        target_type: 'task' as const,
        target_id: '019a0000-0000-7000-8000-000000000701',
        workspace_id: '019a0000-0000-7000-8000-000000000401',
        title: '浮きメニューのお気に入り',
        created_at: '2026-11-10T00:00:00.000Z',
      },
    ],
  }));
  await page.goto('/aoba');
  const trigger = page.locator('.mobile-tabs button');
  const dialog = page.getByRole('dialog', { name: 'すべてのメニュー', exact: true });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('button', { name: /組織を切り替える/ })).toBeVisible();
  for (const name of [
    '今日やること',
    'あおば開発の Wiki',
    '受信箱',
    'バックログ',
    'スプリント',
    '計画',
    'Wiki',
    '接続',
    'メンバー',
    '設定',
  ]) {
    await expect(dialog.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole('link', { name: '浮きメニューのお気に入り', exact: true })).toHaveAttribute(
    'href',
    `${WORKSPACE}/tasks/019a0000-0000-7000-8000-000000000701`,
  );
  // ネイティブのモーダルなので、本文へ focus() しても背景にフォーカスが出ない。
  await page.locator('h1').evaluate((el) => {
    el.setAttribute('tabindex', '-1');
    el.focus();
  });
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  const switcher = dialog.locator('.ws-menu-button');
  await switcher.click();
  await expect(dialog.locator('.ws-menu-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog.locator('.ws-menu-list')).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(switcher).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(2, 2);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole('link', { name: 'メンバー', exact: true }).click();
  await expect(page).toHaveURL(`${WORKSPACE}/members`);
  await expect(dialog).toBeHidden();
});

test('所属先が無い人にはバックログのタブとワークスペースの項目を出さない', async ({ page }) => {
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({ ...output, workspaces: [] }));
  await page.goto('/aoba');
  const tabs = page.getByRole('navigation', { name: 'よく使う画面' });
  await expect(tabs.getByRole('link', { name: 'バックログ', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
  await expect(page.locator('#app-nav a[href*="/w/"]')).toHaveCount(0);
});

test('760pxまでタブを出し、761px以上では既存の枠・検索・表示名を出す', async ({ page }) => {
  await page.goto(WORKSPACE);
  await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
  for (const width of [760, 761, 1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (width <= 760) {
      await expect(page.locator('.mobile-tabs')).toBeVisible();
      await expect(page.locator('.binding')).toHaveCount(0);
    } else {
      await expect(page.locator('.mobile-tabs')).toHaveCount(0);
      await expect(page.locator('.mobile-menu')).toHaveCount(0);
      await expect(page.locator('.binding .brand')).toBeVisible();
      await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeVisible();
      await expect(page.locator('.account-menu-button .me-detail')).toBeVisible();
    }
  }
});

test('浮きメニューを開く間は背景を送らず、本番の組織作成を操作できる', async ({ page }) => {
  await page.goto('/aoba');
  await page.locator('#content').evaluate((element) => {
    element.style.minHeight = '200vh';
  });
  await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
  await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden');
  const position = await page.evaluate(() => scrollY);
  await page.mouse.move(2, 2);
  await page.mouse.wheel(0, 400);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => scrollY)).toBe(position);
  const menu = page.getByRole('dialog', { name: 'すべてのメニュー', exact: true });
  await menu.locator('.org-menu-button').click();
  await menu.getByRole('button', { name: '組織を作る', exact: true }).click();
  const create = page.getByRole('dialog', { name: '組織を作る', exact: true });
  await create.getByLabel('組織の名前', { exact: true }).fill('こもれび工房');
  await expect(create.getByLabel('組織の名前', { exact: true })).toHaveValue('こもれび工房');
  await create.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('html')).not.toHaveCSS('overflow-y', 'hidden');
});
