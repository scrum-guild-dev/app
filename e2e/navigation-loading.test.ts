import { backlogTree } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test('枠の中の遅い移動は本文だけを薄くし、別のリンクで移り直せる', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'admin');
  await page.goto(`${WORKSPACE}/sprint`);
  await expect(page.locator('main.content')).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.passThrough();
  });
  try {
    await page.locator('.binding').getByRole('link', { name: 'バックログ', exact: true }).click();
    const main = page.locator('main.content');
    await expect(main).toHaveAttribute('aria-busy', 'true');
    await expect(main).toHaveCSS('opacity', '0.6');
    await expect(page.locator('.visually-hidden[role="status"]').filter({ hasText: '読み込んでいます' })).toHaveCount(
      1,
    );
    await expect(page.locator('.loading-overlay')).toHaveCount(0);
    await page.locator('.binding').getByRole('link', { name: '今日やること', exact: true }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    await expect(main).not.toHaveAttribute('aria-busy');
  } finally {
    release();
  }
});

test('遅い移動の完了で戻り、引き出しでは本文を薄くしない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto(`${WORKSPACE}/sprint`);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.passThrough();
  });
  try {
    await page.locator('.binding').getByRole('link', { name: 'バックログ', exact: true }).click();
    await expect(page.locator('main.content')).toHaveAttribute('aria-busy', 'true');
  } finally {
    release();
  }
  await expect(page).toHaveURL(new RegExp(`${WORKSPACE}$`));
  await expect(page.locator('main.content')).not.toHaveAttribute('aria-busy');
  await page.getByRole('link', { name: 'ポイント付与のバッチを作る', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('main.content')).not.toHaveAttribute('aria-busy');
});

// APIの10秒の打ち切りとaxeの所要時間を競合させないよう、配線は上の実遷移、
// 4テーマの見た目は読み終わった本文に同じ属性を付けた部品の状態で確かめる。
test('読み込み中の本文に4テーマでaxeの違反が無い', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'admin');
  await page.goto(`${WORKSPACE}/sprint`);
  await expect(page.locator('main.content')).toBeVisible();
  await page.locator('main.content').evaluate((main) => main.setAttribute('aria-busy', 'true'));
  await expect(page.locator('main.content')).toHaveCSS('opacity', '0.6');
  await expectNoA11yViolationsInThemes(page, 'sprint');
  await expect(page.locator('main.content')).toHaveAttribute('aria-busy', 'true');
});
