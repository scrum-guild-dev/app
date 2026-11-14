import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { isDevBuild } from '../scripts/e2e-server.ts';
import { themes } from '../src/shared/theme.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { rewriteOperation } from './operations.ts';

function createSheetPath(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../.svelte-kit/output/client/.vite/manifest.json', import.meta.url), 'utf8'),
  ) as Record<string, { file: string; isDynamicEntry?: boolean }>;
  const sheet = manifest['src/lib/components/CreateSheet.svelte'];
  expect(sheet?.isDynamicEntry).toBe(true);
  return `/${sheet.file}`;
}

for (const theme of themes) {
  test(`${theme}: 今日の初回表示はJSが50件以内で、起票シートは押すまで読まない`, async ({ page, context, baseURL }) => {
    if (!baseURL) throw new Error('baseURL が無い');
    await signIn(context, baseURL, 'admin');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((value) => localStorage.setItem('sg-theme', value), theme);
    await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (body) => {
      body.me.theme = theme;
      return body;
    });
    const sheetPath = createSheetPath();
    const scripts = new Set<string>();
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.add(new URL(request.url()).pathname);
    });
    await page.goto('/aoba');
    await expect(page.getByRole('heading', { name: '今日やること', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.app-version')).toContainText(/版\s+\S+/);
    await page.waitForLoadState('networkidle');
    expect(scripts.has(sheetPath)).toBe(false);
    // 開発時の警告を含む build は、本番の本数とは比べない。
    if (!isDevBuild(process.env)) expect(scripts.size).toBeLessThanOrEqual(50);
    const trigger = page.getByRole('button', { name: '起票', exact: true });
    const controlledId = await trigger.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    await expect(page.locator(`[id="${controlledId}"]`)).toHaveCount(1);
    await trigger.click();
    const sheet = page.getByRole('dialog', { name: '起票', exact: true });
    await expect(sheet.getByLabel('タイトル', { exact: true })).toBeFocused();
    expect(scripts.has(sheetPath)).toBe(true);
    await sheet.getByLabel('本文', { exact: true }).fill('遅延読み込み後も本文を編集できる');
    await sheet.getByLabel('本文', { exact: true }).fill('');
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(sheet.getByLabel('タイトル', { exact: true })).toBeFocused();
  });
}

test('起票のコードを読み込めなければ失敗を知らせ、フォーカスを奪わない', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 390, height: 844 });
  const sheetPath = createSheetPath();
  await page.route(
    (url) => url.pathname === sheetPath,
    (route) => route.abort('failed'),
  );
  await page.goto('/aoba');
  const trigger = page.getByRole('button', { name: '起票', exact: true });
  await trigger.click();
  await expect(page.getByRole('status').filter({ hasText: '読み込めませんでした' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '起票', exact: true })).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('起票の読み込み中に連打して別画面へ移っても、古いシートを開かない', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 390, height: 844 });
  const sheetPath = createSheetPath();
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (requested = resolve));
  let requests = 0;
  await page.route(
    (url) => url.pathname === sheetPath,
    async (route) => {
      requests++;
      requested();
      await held;
      await route.continue();
    },
  );
  try {
    await page.goto('/aoba');
    const trigger = page.getByRole('button', { name: '起票', exact: true });
    await trigger.click();
    await started;
    await expect(trigger).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.toast').filter({ hasText: '読み込んでいます' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '読み込んでいます' }).first()).toBeVisible();
    await trigger.click();
    await page.locator('.mobile-tabs').getByRole('link', { name: 'バックログ', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'バックログ', exact: true })).toBeVisible();
    await expect(page.locator('.toast').filter({ hasText: '読み込んでいます' })).toHaveCount(0);
    const nextTrigger = page.getByRole('button', { name: '起票', exact: true });
    await expect(nextTrigger).not.toHaveAttribute('aria-busy', 'true');
    await nextTrigger.click();
    await expect(nextTrigger).toHaveAttribute('aria-busy', 'true');
    release();
    await page.waitForLoadState('networkidle');
    expect(requests).toBe(1);
    await expect(
      page.getByRole('dialog', { name: '起票', exact: true }).getByLabel('タイトル', { exact: true }),
    ).toBeFocused();
  } finally {
    release();
  }
});
