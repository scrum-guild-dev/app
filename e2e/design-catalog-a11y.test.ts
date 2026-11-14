import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, findA11yViolations, formatA11yViolations } from './helpers.ts';

// アプリの配信対象外の見本を、既存の design-catalog.test.ts と同じ方法で開く。seed の認証は使わない。
// 大きなカタログの axe 検査と trace の記録に余裕を持たせる。各 assertion の待ちは延ばさない。
test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const files: Record<string, string> = {
    'index.html': 'text/html',
    'tokens.css': 'text/css',
    'components.css': 'text/css',
    'icons.js': 'text/javascript',
    'art.js': 'text/javascript',
    'sample-data.js': 'text/javascript',
    'kit.js': 'text/javascript',
  };
  await page.route('**/__design-catalog/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    const contentType = files[name];
    if (!contentType) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ contentType, body: readFileSync(new URL(`../design/${name}`, import.meta.url)) });
  });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    await page.route(`https://${host}/**`, (route) => route.fulfill({ body: '' }));
  }
});

async function openCatalog(page: Page): Promise<void> {
  await page.goto('/__design-catalog/index.html');
  await expect(page.getByRole('heading', { level: 1, name: 'デザインシステム', exact: true })).toBeVisible();
  const links = page.locator('#toc a');
  expect(await links.count()).toBeGreaterThan(0);
  await expect(page.locator('#main > .cat-block')).toHaveCount(await links.count());
  for (const link of await links.all()) {
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^#.+/);
    await expect(page.locator(`#main > .cat-block${href}`)).toBeVisible();
  }
}

async function expectAccessibleCatalog(page: Page): Promise<void> {
  // 除外は設けず、カタログ全体を WCAG A/AA（コントラストを含む）で測る。
  const violations = await findA11yViolations(page);
  if (violations.length > 0) throw new Error(formatA11yViolations(violations));
}

// layout-narrow*.test.ts は本番の画面が対象なので、見本の狭幅もここで測る。
for (const width of [1280, 390]) {
  for (const theme of A11Y_THEMES) {
    test(`見本のカタログの axe: ${width}px / ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await openCatalog(page);
      await applyTheme(page, theme);
      await expectAccessibleCatalog(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });
  }
}

test('壊したカタログの無名ボタンと低コントラスト文字で、検査が落ちる', async ({ page }) => {
  await openCatalog(page);
  await applyTheme(page, A11Y_THEMES[0]);
  await page.locator('#main').evaluate((main) => {
    const broken = document.createElement('div');
    broken.innerHTML =
      '<button type="button" id="broken-button"></button>' +
      '<p id="broken-contrast" style="color:#999;background:#aaa">Faint text</p>';
    main.prepend(broken);
  });
  // 別の既存違反による失敗では足りず、仕込んだ2つを検査の入口が報告することを確かめる。
  const checked = expectAccessibleCatalog(page);
  await expect(checked).rejects.toThrow(/- button-name: #broken-button/);
  await expect(checked).rejects.toThrow(/- color-contrast: #broken-contrast/);
});
