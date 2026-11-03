import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { orgWikiPage, orgWikiTree } from '../src/shared/operations/wiki/index.ts';
import { failOperation, rewriteOperation } from './operations.ts';

test('長い組織名がメニューに収まり、画面内の移動で権限を失ったときは見つからないと示す', async ({ page }) => {
  const name = 'A'.repeat(80);
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    organization: { ...output.organization, name },
  }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/aoba/wiki');
  const menu = page.locator('.nav-item-label', { hasText: `${name}の Wiki` });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill('権限の変化を確認するページ');
  await page.getByLabel('本文', { exact: true }).fill('本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki\/[0-9a-f-]{36}$/);
  const url = page.url();
  await failOperation(page, orgWikiTree, { slug: 'aoba' }, 404, 'not_found');
  await failOperation(page, orgWikiPage, { slug: 'aoba' }, 404, 'not_found');
  // 親の組織レイアウトが再取得されない、同じ slug の画面内での移動。
  await page.locator('.nav-item', { hasText: `${name}の Wiki` }).click();
  await expect(page.getByText('ページが見つかりません', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ページを足す', exact: true })).toHaveCount(0);
  await page.goto(url);
  await expect(page.getByText('ページが見つかりません', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ページを足す', exact: true })).toHaveCount(0);
});

test('組織のメニューから Wiki を開き、親子のページを作って同じ URL のまま編集できる', async ({ page }) => {
  const violations = await watchViolations(page);
  await page.goto('/aoba');
  await page.locator('.nav-item', { hasText: 'あおば開発の Wiki' }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki$/);
  await expect(page.locator('.page-eyebrow')).toHaveText('あおば開発');
  await expect(page.getByText('この組織の全員が、読んで書けます。', { exact: true })).toBeVisible();
  const title = `組織の手順-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill(title);
  await page.getByLabel('本文', { exact: true }).fill('# 全体の手順\n\n![外部画像](https://example.test/org-wiki.png)');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki\/[0-9a-f-]{36}$/);
  const parentUrl = page.url();
  await expect(page.locator('.doc-box img')).toHaveCount(0);
  await expect(page.locator('.doc-box a', { hasText: '外部画像' })).toHaveAttribute('target', '_blank');
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('あおば開発の Wiki');
  await page.getByRole('button', { name: '子のページを足す' }).click();
  await page.getByLabel('本文', { exact: true }).fill(`---\ntitle: 子-${title}\n---\n[親の手順](${parentUrl})`);
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: `子-${title}` })).toBeVisible();
  const childUrl = page.url();
  await page.getByRole('button', { name: '編集する' }).click();
  await page.getByLabel('本文', { exact: true }).fill(`---\ntitle: 改訂-${title}\n---\n[親の手順](${parentUrl})`);
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: `改訂-${title}` })).toBeVisible();
  expect(page.url()).toBe(childUrl);
  const parentLink = page.locator('.doc-box a', { hasText: '親の手順' });
  await expect(parentLink).not.toHaveAttribute('target', '_blank');
  await parentLink.click();
  await expect(page).toHaveURL(parentUrl);
  await page.reload();
  await page.getByRole('button', { name: `${title}を開く`, exact: true }).click();
  await page
    .getByRole('navigation', { name: '組織の Wiki のページ' })
    .getByRole('link', { name: `改訂-${title}`, exact: true })
    .click();
  await expect(page).toHaveURL(childUrl);
  for (const width of [1280, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole('heading', { level: 2, name: `改訂-${title}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(await violations()).toEqual([]);
});

test('組織の Wiki も競合時に書きかけを残し、権限のない人には存在を見せない', async ({ page, context, baseURL }) => {
  await page.goto('/aoba/wiki');
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill(`組織の同時編集-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel('本文', { exact: true }).fill('最初の本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki\/[0-9a-f-]{36}$/);
  const url = page.url();
  const other = await context.newPage();
  await other.goto(url);
  await other.getByRole('button', { name: '編集する' }).click();
  await other.getByLabel('本文', { exact: true }).fill('手元の書きかけ');
  await page.getByRole('button', { name: '編集する' }).click();
  await page.getByLabel('本文', { exact: true }).fill('先に保存した本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('button', { name: '編集する' })).toBeVisible();
  await other.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('他の人が先に保存したため');
  await expect(other.getByLabel('本文', { exact: true })).toHaveValue('手元の書きかけ');
  await other.getByRole('button', { name: '今の版を読み直す' }).click();
  await other.getByText('今の版を見る（第2版）', { exact: true }).click();
  await expect(other.locator('details').first()).toContainText('先に保存した本文');
  await other.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(other.getByRole('button', { name: '編集する' })).toBeVisible();
  await expect(other.locator('.doc-box')).toContainText('手元の書きかけ');
  await other.close();
  for (const who of ['leftAll', 'otherOrg'] as const) {
    await signIn(context, baseURL, who);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: '組織が見つかりません' })).toBeVisible();
  }
});

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

for (const scope of ['organization', 'workspace'] as const) {
  test(`${scope}: 前の版の題と本文を読み、確認して戻し、競合時は上書きしない`, async ({ page, context }) => {
    const violations = await watchViolations(page);
    if (scope === 'workspace') {
      await createWorkspace(page, 'Wikiの版を戻す');
      await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
    } else await page.goto('/aoba/wiki');
    const title = 'A'.repeat(100);
    await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
    await page.getByLabel('題', { exact: true }).fill(title);
    await page.getByLabel('本文', { exact: true }).fill('# 以前の本文');
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: '編集する', exact: true }).click();
    await page.getByLabel('題', { exact: true }).fill('新しい題');
    await page.getByLabel('本文', { exact: true }).fill(`# 新しい本文\n\n[同じページ](${page.url()})`);
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(page.getByRole('button', { name: '編集する', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('第2版');
    await expect(rows.last()).toContainText(title);
    for (const width of [320, 390, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.getByRole('button', { name: '第1版を見る', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeFocused();
    await expect(page.locator('.doc-box')).toContainText('以前の本文');
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('第3版として足されます');
    await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    let release!: () => void;
    let received!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      received = resolve;
    });
    const operation = scope === 'workspace' ? '**/workspace-wiki-update' : '**/org-wiki-update';
    await page.route(operation, async (route) => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await pending;
    try {
      await expect(page.getByRole('button', { name: 'ページを足す', exact: true })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await page.getByRole('button', { name: 'ページを足す', exact: true }).click({ force: true });
      await expect(page.getByLabel('題', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    } finally {
      release();
    }
    await expect(page.getByRole('status').filter({ hasText: '第3版として保存しました' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    await page.unroute(operation);
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('第3版');
    await page.getByRole('button', { name: '第2版を見る', exact: true }).click();
    await expect(page.locator('.doc-box a', { hasText: '同じページ' })).not.toHaveAttribute('target', '_blank');
    const other = await context.newPage();
    await other.goto(page.url());
    await other.getByRole('button', { name: '編集する', exact: true }).click();
    await other.getByLabel('本文', { exact: true }).fill('# 他の人の本文');
    await other.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(other.getByRole('button', { name: '編集する', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await dialog.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('他の人が先に保存したため、戻せませんでした');
    await page.getByRole('button', { name: '版の一覧を読み直す', exact: true }).click();
    await expect(rows.first()).toContainText('第4版');
    await expect(rows.first()).toContainText('今の版');
    await page.getByRole('button', { name: '第4版を見る', exact: true }).click();
    await expect(page.getByText('第4版を見ています。今の版は第4版です。')).toBeVisible();
    await expect(page.getByRole('button', { name: 'この版に戻す', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'ページへ戻る', exact: true }).click();
    await expect(page.locator('.doc-box')).toContainText('他の人の本文');
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await expect(rows).toHaveCount(4);
    for (const width of [320, 390, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    // 意図して起こした復元競合の409だけを許容し、他のconsole/CSPエラーは引き続き検査する。
    expect(await violations()).toEqual([
      'Failed to load resource: the server responded with a status of 409 (Conflict)',
    ]);
    await other.close();
  });
}
