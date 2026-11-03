import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { failOperation } from './operations.ts';
import { workspaceWikiMove } from '../src/shared/operations/wiki/index.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function add(page: Page, title: string) {
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill(title);
  await page.getByLabel('本文', { exact: true }).fill(`本文 ${title}`);
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
  return page.url();
}
for (const scope of ['org', 'workspace'] as const) {
  test(`${scope} Wiki の順序と親をボタン・キーボードで変え、URLと再読込み後の木を保つ`, async ({ page }) => {
    const violations = await watchViolations(page);
    if (scope === 'workspace') {
      await createWorkspace(page, 'Wikiの移動');
      await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
    } else await page.goto('/aoba/wiki');
    const suffix = crypto.randomUUID().slice(0, 8);
    const first = `先-${suffix}`,
      second = `後-${suffix}`;
    await add(page, first);
    const url = await add(page, second);
    await page.getByRole('button', { name: '並べ替える', exact: true }).click();
    const up = page.getByRole('button', { name: `上へ: ${second}`, exact: true });
    await up.focus();
    await up.press('Enter');
    await expect(page.locator('.wiki-side > .field-hint')).toContainText('移しました。');
    const tree = page.locator('.wiki-tree');
    await expect
      .poll(async () => {
        const titles = await tree.locator(':scope > li > .wiki-node > a').allTextContents();
        return titles.indexOf(second) >= 0 && titles.indexOf(second) < titles.indexOf(first);
      })
      .toBe(true);
    await expect(up).toBeFocused();
    await page.getByRole('button', { name: `親を移す: ${second}`, exact: true }).focus();
    await page.getByRole('button', { name: `親を移す: ${second}`, exact: true }).press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').selectOption({ label: first });
    await dialog.getByRole('button', { name: '移す', exact: true }).click();
    await expect(page.locator('.crumbs')).toContainText(first);
    await expect(page.getByRole('button', { name: `親を移す: ${second}`, exact: true })).toBeFocused();
    expect(page.url()).toBe(url);
    await page.reload();
    await expect(page.locator('.crumbs')).toContainText(first);
    await page.getByRole('button', { name: '並べ替える', exact: true }).click();
    await page.getByRole('button', { name: `親を移す: ${first}`, exact: true }).click();
    await expect(dialog.getByRole('option', { name: second, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('option', { name: first, exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
    await page.getByRole('button', { name: `親を移す: ${second}`, exact: true }).click();
    await dialog.getByRole('combobox').selectOption({ label: '最上段' });
    await dialog.getByRole('button', { name: '移す', exact: true }).click();
    await expect(page.locator('.crumbs')).not.toContainText(first);
    expect(page.url()).toBe(url);
    await expect(tree.locator('[data-wiki-handle]').first()).toHaveAttribute('aria-hidden', 'true');
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width <= 390) await expect(page.locator('[data-wiki-handle]:visible')).toHaveCount(0);
    }
    expect(await violations()).toEqual([]);
  });
}

test('Wiki のつまみをドラッグして兄弟の間と子へ移す', async ({ page }) => {
  await createWorkspace(page, 'Wikiのドラッグ');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await add(page, '親の手順');
  const url = await add(page, '動かす手順');
  await page.getByRole('button', { name: '並べ替える', exact: true }).click();
  const handle = page
    .locator('.wiki-node')
    .filter({ has: page.getByRole('link', { name: '動かす手順', exact: true }) })
    .locator('[data-wiki-handle]');
  const target = page.locator('.wiki-node').filter({ has: page.getByRole('link', { name: '親の手順', exact: true }) });
  await handle.dragTo(target, { targetPosition: { x: 80, y: 2 } });
  await expect(page.locator('.wiki-side > .field-hint')).toContainText('移しました。');
  await expect(page.locator('.wiki-tree > li > .wiki-node > a').first()).toHaveText('動かす手順');
  await handle.dragTo(target);
  await expect(page.locator('.crumbs')).toContainText('親の手順');
  expect(page.url()).toBe(url);
  await page.reload();
  await expect(page.locator('.crumbs')).toContainText('親の手順');
  await page.getByRole('button', { name: '並べ替える', exact: true }).click();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await handle.dragTo(target, { targetPosition: { x: 80, y: box!.height - 2 } });
  await expect(page.locator('.crumbs')).not.toContainText('親の手順');
  await expect(page.locator('.wiki-tree > li > .wiki-node > a')).toHaveText(['親の手順', '動かす手順']);
  expect(page.url()).toBe(url);
});

test('遅い移動応答が編集中のフォーカスを奪わない', async ({ page }) => {
  await createWorkspace(page, 'Wikiの遅い移動');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await add(page, '前のページ');
  await add(page, '編集中のページ');
  await page.getByRole('button', { name: '並べ替える', exact: true }).click();
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route('**/workspace-wiki-move', async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '上へ: 編集中のページ', exact: true }).click();
  await pending;
  try {
    await page.getByRole('button', { name: '編集する', exact: true }).click();
    await page.getByLabel('本文', { exact: true }).fill('書きかけを保つ');
  } finally {
    release();
  }
  await expect(page.locator('.wiki-side > .field-hint')).toContainText('移しました。');
  await expect(page.locator('.wiki-tree > li > .wiki-node > a').first()).toHaveText('編集中のページ');
  await expect(page.getByLabel('本文', { exact: true })).toBeFocused();
  await expect(page.getByLabel('本文', { exact: true })).toHaveValue('書きかけを保つ');
});

test('移動が失敗したらトーストと木の上に理由を残す', async ({ page }) => {
  await createWorkspace(page, 'Wikiの移動の失敗');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await add(page, '親のページ');
  const url = await add(page, '動かせないページ');
  await failOperation(page, workspaceWikiMove, { slug: 'aoba' }, 409, 'conflict', { details: { reason: 'too_deep' } });
  await page.getByRole('button', { name: '親を移す', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox').selectOption({ label: '親のページ' });
  await dialog.getByRole('button', { name: '移す', exact: true }).click();
  await expect(
    page.locator('.toast:visible').filter({ hasText: '子のページを含めて10段を超えるため、移せません。' }),
  ).toBeVisible();
  const feedback = page.locator('.wiki-side > .field-hint');
  await expect(feedback).toHaveText('子のページを含めて10段を超えるため、移せません。');
  expect(await feedback.evaluate((element) => !!element.nextElementSibling?.matches('nav'))).toBe(true);
  expect(page.url()).toBe(url);
});
