import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

const themes = ['simple_light', 'simple_dark', 'medieval', 'modern'];

async function expectHorizontalBrand(page: Page): Promise<void> {
  const art = page.locator('.brand-art');
  const logo = art.locator('.brand-name');
  await expect(art).toHaveCount(1);
  await expect(art).toHaveAttribute('aria-hidden', 'true');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('alt', '');
  await expect(art.locator('.brand-mark')).toBeHidden();
  await expect(art).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect.poll(() => logo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect
    .poll(() => logo.evaluate((img) => (img as HTMLImageElement).currentSrc))
    .toMatch(/\/brand\/header\/logo-transparent-(600|1200)\.png$/);
  const box = (await logo.boundingBox())!;
  expect(box.width).toBeGreaterThan(100);
  expect(Math.abs(box.width / box.height - 3)).toBeLessThan(0.02);
  const parent = (await art.locator('..').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(parent.x);
  expect(box.x + box.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // 画像内の文字は読ませず、サービス名を1回だけ残す
  await expect(art.locator('..').getByText('Scrum Guild', { exact: true })).toHaveCount(1);
}

for (const screen of [
  { path: '/login', who: null },
  { path: '/', who: 'admin' },
  { path: '/aoba/w/019a0000-0000-7000-8000-000000000401', who: 'member' },
  { path: '/operator', who: 'operator' },
] as const) {
  test(`${screen.path} のロゴが全テーマと狭い幅で提供素材になり、切れずに収まる`, async ({
    page,
    context,
    baseURL,
  }) => {
    if (screen.who) await signIn(context, baseURL, screen.who);
    await page.goto(screen.path);
    await expect(page).toHaveURL(new URL(screen.path, baseURL).href);
    await expect(page.locator('.brand-art')).toBeVisible();
    for (const width of [320, 390, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of themes) {
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        await expectHorizontalBrand(page);
      }
    }
  });
}

test('畳んだメニューはマーク単体で名前を保ち、狭い幅では横組みに戻る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/aoba');
  const brand = page.getByRole('link', { name: 'Scrum Guild', exact: true });
  await expect(brand).toHaveAttribute('href', '/aoba');
  await expectHorizontalBrand(page);
  await page.getByRole('button', { name: 'メニューを畳む' }).click();
  for (const theme of themes) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await expect(brand.locator('.brand-name')).toHaveJSProperty('offsetWidth', 1);
    const symbol = brand.locator('.brand-mark');
    await expect(symbol).toBeVisible();
    await expect.poll(() => symbol.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(629);
    const box = (await symbol.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(64);
    await expect(brand).toHaveAccessibleName('Scrum Guild');
  }
  await page.setViewportSize({ width: 390, height: 700 });
  await expectHorizontalBrand(page);
});

test('faviconとホーム画面アイコンがHTMLではなく画像として配信される', async ({ page, request }) => {
  await page.goto('/login');
  const paths = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestResponse = await request.get(manifestUrl!);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  for (const path of [...paths, ...manifest.icons.map((icon: { src: string }) => icon.src)]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toMatch(/^image\//);
    expect((await response.body()).length).toBeGreaterThan(100);
  }
});
