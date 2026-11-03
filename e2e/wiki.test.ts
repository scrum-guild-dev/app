import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('Wiki の木から親子を作り、番号の URL のまま題と本文を直せる', async ({ page }) => {
  const violations = await watchViolations(page);
  await createWorkspace(page, 'Wikiの手順書');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Wiki' })).toBeVisible();
  await expect(page.getByText('ページはまだありません', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill('開発の手順');
  await page
    .getByLabel('本文', { exact: true })
    .fill('# チームの手順\n\n![外部画像](https://example.test/wiki-image.png)');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/[0-9a-f-]{36}$/);
  const parentUrl = page.url();
  await expect(page.getByRole('heading', { level: 2, name: '開発の手順' })).toBeVisible();
  await expect(page.locator('.doc-box img')).toHaveCount(0);
  await expect(page.locator('.doc-box a', { hasText: '外部画像' })).toHaveAttribute('target', '_blank');
  await page.getByRole('button', { name: '子のページを足す' }).click();
  await page.getByLabel('本文', { exact: true }).fill('---\ntitle: 子の手順\n---\n## 準備');
  await expect(page.getByLabel('題', { exact: true })).toHaveValue('子の手順');
  await expect(page.getByLabel('題', { exact: true })).toHaveAttribute('readonly');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: '子の手順' })).toBeVisible();
  const childUrl = page.url();
  await page.getByRole('button', { name: '編集する' }).click();
  await page.getByLabel('本文', { exact: true }).fill(`---\ntitle: 新しい手順\n---\n[親の手順](${parentUrl})`);
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: '新しい手順' })).toBeVisible();
  expect(page.url()).toBe(childUrl);
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('Wiki');
  const parentLink = page.locator('.doc-box a', { hasText: '親の手順' });
  await expect(parentLink).not.toHaveAttribute('target', '_blank');
  await parentLink.click();
  await expect(page).toHaveURL(parentUrl);
  await page.setViewportSize({ width: 320, height: 760 });
  await expect(page.getByRole('heading', { level: 2, name: '開発の手順' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await violations()).toEqual([]);
});

test('同時保存の競合で入力を残し、今の版と見比べてから保存する', async ({ page, context }) => {
  await createWorkspace(page, 'Wikiの同時編集');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill('共有の決まり');
  await page.getByLabel('本文', { exact: true }).fill('最初の本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/[0-9a-f-]{36}$/);
  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByRole('button', { name: '編集する' }).click();
  await other.getByLabel('本文', { exact: true }).fill('手元の書きかけ');
  await page.getByRole('button', { name: '編集する' }).click();
  await page.getByLabel('本文', { exact: true }).fill('先に保存した本文');
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route('**/workspace-wiki-update', async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await pending;
  try {
    await expect(page.getByLabel('題', { exact: true })).toHaveAttribute('readonly');
    await expect(page.getByLabel('本文', { exact: true })).toHaveAttribute('readonly');
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: '編集する' })).toBeVisible();
  await other.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('他の人が先に保存したため');
  await expect(other.getByLabel('本文', { exact: true })).toHaveValue('手元の書きかけ');
  await other.getByRole('button', { name: '今の版を読み直す' }).click();
  await other.getByText('今の版を見る（第2版）', { exact: true }).click();
  await expect(other.locator('details').first()).toContainText('先に保存した本文');
  await expect(other.getByLabel('本文', { exact: true })).toHaveValue('手元の書きかけ');
  // 編集開始時の本文に戻しても、先に保存された第2版とは異なるので、第3版として保存する。
  await other.getByLabel('本文', { exact: true }).fill('最初の本文');
  await other.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(other.getByRole('button', { name: '編集する' })).toBeVisible();
  await expect(other.locator('.doc-box')).toContainText('最初の本文');
  await other.close();
});

test('保存前の入力を捨てるときは確かめ、文字数の誤りは欄に示す', async ({ page }) => {
  await createWorkspace(page, 'Wikiの入力確認');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill('長'.repeat(101));
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByLabel('題', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('題', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '続けて書く' }).click();
  await expect(page.getByLabel('題', { exact: true })).toHaveValue('長'.repeat(101));
  await page.getByRole('button', { name: 'やめる', exact: true }).click();
  await page.getByRole('button', { name: '捨てて移る' }).click();
  await expect(page.getByText('ページはまだありません', { exact: true })).toBeVisible();
});
