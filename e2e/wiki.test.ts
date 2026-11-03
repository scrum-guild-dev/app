import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { resetWikiRateLimits } from './local-d1.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import {
  orgWikiPage,
  orgWikiTree,
  orgWikiUpdate,
  orgWikiRevisions,
  workspaceWikiPage,
  workspaceWikiTree,
  workspaceWikiUpdate,
  workspaceWikiRevisions,
  workspaceWikiCreate,
  workspaceWikiSearch,
} from '../src/shared/operations/wiki/index.ts';
import { failOperation, mockOperation, rewriteOperation, routeOperation } from './operations.ts';

test('自分用の組織の Wiki は組織の表示名で案内する', async ({ page }) => {
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    organization: { ...output.organization, kind: 'personal' as const },
  }));
  await page.goto('/aoba/wiki');
  await expect(page.locator('.nav-item', { hasText: '自分用の Wiki' })).toBeVisible();
  await expect(page.locator('.page-eyebrow')).toHaveText('自分用');
  await expect(page).toHaveTitle('Wiki・自分用 - Scrum Guild');
});

test('長い組織名がメニューに収まり、画面内の移動で権限を失ったときは見つからないと示す', async ({ page }) => {
  const name = 'A'.repeat(80);
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    organization: { ...output.organization, name },
  }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/aoba/wiki');
  const menu = page.locator('.nav-item-label', { hasText: `${name}の Wiki` });
  for (const width of [1280, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await menu.evaluate((element) => element.getBoundingClientRect().width < window.innerWidth)).toBe(true);
    if (width <= 390) {
      const ordinary = page.getByRole('link', { name: '今日やること', exact: true });
      const menuHeight = await menu.evaluate((element) => element.closest('.nav-item')!.getBoundingClientRect().height);
      expect(await ordinary.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(menuHeight);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
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
  await expect(page.getByText('この組織の全員が、読んで書けます。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ページを足す', exact: true })).toHaveCount(0);
  await page.goto(url);
  await expect(page.getByText('ページが見つかりません', { exact: true })).toBeVisible();
  await expect(page.getByText('この組織の全員が、読んで書けます。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ページを足す', exact: true })).toHaveCount(0);
});

test('組織のメニューから Wiki を開き、親子のページを作って同じ URL のまま編集できる', async ({ page }) => {
  const violations = await watchViolations(page);
  await page.goto('/aoba');
  await page.locator('.nav-item', { hasText: 'あおば開発の Wiki' }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki$/);
  await expect(page).toHaveTitle('Wiki・あおば開発 - Scrum Guild');
  await expect(page.locator('.page-eyebrow')).toHaveText('あおば開発');
  await expect(page.getByText('この組織の全員が、読んで書けます。', { exact: true })).toBeVisible();
  const title = `組織の手順-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill(title);
  await page
    .getByLabel('本文', { exact: true })
    .fill('---\n担当: 共通の窓口\n---\n# 全体の手順\n\n![外部画像](https://example.test/org-wiki.png)');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki\/[0-9a-f-]{36}$/);
  const parentUrl = page.url();
  await expect(page.getByRole('cell', { name: '共通の窓口', exact: true })).toBeVisible();
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
  await expect(page).toHaveTitle(`改訂-${title}・あおば開発 - Scrum Guild`);
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
  await expect(other.locator('.doc-box > p')).toHaveText('手元の書きかけ');
  await other.close();
  for (const who of ['leftAll', 'otherOrg'] as const) {
    await signIn(context, baseURL, who);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: '組織が見つかりません' })).toBeVisible();
  }
});

test.beforeEach(async ({ context, baseURL }) => {
  await resetWikiRateLimits();
  await signIn(context, baseURL, 'admin');
});

test('frontmatter を表で読み、読めない YAML と値の無いページも保存して読める', async ({ page }) => {
  const violations = await watchViolations(page);
  await createWorkspace(page, 'Wikiのメタデータ');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  const source =
    '---\ntitle: 手順の情報\nowner: 青葉\nreviewed: 2026-11-03\npeople: [青葉, 若葉]\nreview: {done: true}\nblank: ""\nmarkup: "<img src=x> **文字**"\n' +
    '長いキー'.repeat(30) +
    ': ' +
    '長い値'.repeat(100) +
    '\n---\n## 実際の本文';
  await page.getByLabel('本文', { exact: true }).fill(source);
  await page.getByText('プレビュー', { exact: true }).click();
  const properties = page.getByRole('table', { name: 'ページの frontmatter（題を除く）' });
  await expect(properties.getByRole('rowheader', { name: 'owner', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(properties).toBeVisible();
  await expect(properties.getByRole('row')).toHaveCount(8);
  await expect(properties.getByRole('cell', { name: '2026-11-03', exact: true })).toBeVisible();
  await expect(properties.getByRole('cell', { name: '[ "青葉", "若葉" ]', exact: true })).toBeVisible();
  await expect(properties.getByRole('cell', { name: '{ "done": true }', exact: true })).toBeVisible();
  await expect(properties.getByRole('cell', { name: '<img src=x> **文字**', exact: true })).toBeVisible();
  await expect(properties.getByRole('cell', { name: '（空）', exact: true })).toBeVisible();
  await expect(properties.locator('img, strong, a')).toHaveCount(0);
  await expect(properties.getByRole('rowheader', { name: 'title', exact: true })).toHaveCount(0);
  await expect(page.locator('.doc-box')).not.toContainText('owner:');
  await expect(page.getByRole('heading', { name: '実際の本文', exact: true })).toBeVisible();
  for (const width of [320, 390, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(properties).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  await page.getByRole('button', { name: '編集する', exact: true }).click();
  await page.getByLabel('本文', { exact: true }).fill('---\ntitle: 123\n---\n無効な題の本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('button', { name: '編集する', exact: true })).toBeVisible();
  await expect(properties.getByRole('rowheader', { name: 'title', exact: true })).toBeVisible();
  await expect(properties.getByRole('cell', { name: '123', exact: true })).toBeVisible();

  for (const body of [
    '---\nowner: [\n---\n## 読めない YAML の本文',
    'frontmatter の無い本文',
    '---\ntitle: 題だけのページ\n---\n題だけの本文',
  ]) {
    await page.getByRole('button', { name: '編集する', exact: true }).click();
    await page.getByLabel('本文', { exact: true }).fill(body);
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(page.getByRole('button', { name: '編集する', exact: true })).toBeVisible();
    await expect(properties).toHaveCount(0);
    const warning = page.getByText('frontmatter を読めません。本文として表示しています。', { exact: true });
    if (body.includes('owner: [')) {
      await expect(warning).toBeVisible();
      await expect(page.locator('.doc-box')).toContainText('owner: [');
      await expect(page.getByRole('heading', { name: '読めない YAML の本文', exact: true })).toBeVisible();
    } else {
      await expect(warning).toHaveCount(0);
      await expect(page.locator('.doc-box')).toContainText(body.includes('title:') ? '題だけの本文' : body);
    }
  }
  expect(await violations()).toEqual([]);
});

test('Wiki の木から親子を作り、番号の URL のまま題と本文を直せる', async ({ page }) => {
  const violations = await watchViolations(page);
  await createWorkspace(page, 'Wikiの手順書');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await expect(page).toHaveTitle('Wiki・Wikiの手順書 - Scrum Guild');
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
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      operationPath(workspaceWikiCreate, new URL(page.url()).pathname.split('/')[1]!),
  );
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  const response = await created;
  await response.finished();
  expect(response.status()).toBe(200);
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
    await page.getByLabel('本文', { exact: true }).fill('---\ncategory: 過去の分類\n---\n# 以前の本文');
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: '編集する', exact: true }).click();
    await page.getByLabel('題', { exact: true }).fill('新しい題');
    await page.getByLabel('本文', { exact: true }).fill(`# 新しい本文\n\n[同じページ](${page.url()})`);
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(page.getByRole('button', { name: '編集する', exact: true })).toBeVisible();
    const originalUrl = page.url();
    await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
    await page.getByLabel('題', { exact: true }).fill('別のページ');
    await page.getByLabel('本文', { exact: true }).fill('移動先の本文');
    await page.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: '別のページ' })).toBeVisible();
    const otherPath = new URL(page.url()).pathname;
    const originalPath = new URL(originalUrl).pathname;
    await page.locator(`.wiki-side a[href="${originalPath}"]`).click();
    await expect(page).toHaveURL(originalUrl);
    await expect(page.getByRole('heading', { level: 2, name: '新しい題' })).toBeVisible();
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: '版の一覧' })).toBeVisible();
    await page.locator(`.wiki-side a[href="${otherPath}"]`).click();
    await expect(page.getByRole('heading', { level: 2, name: '別のページ' })).toBeVisible();
    await page.locator(`.wiki-side a[href="${originalPath}"]`).click();
    await expect(page.getByRole('heading', { level: 2, name: '新しい題' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ページへ戻る', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('第2版');
    await expect(rows.last()).toContainText(title);
    await expect(page.getByRole('columnheader', { name: '操作', exact: true })).toHaveCount(1);
    await expect(rows.first().locator('.chip.is-ok')).toHaveText('今の版');
    await expect(rows.first().getByRole('button')).toHaveText('開く');
    await expect(rows.last().getByRole('button')).toHaveText('この版を見る');
    for (const width of [320, 390, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width <= 390)
        expect(
          await rows
            .first()
            .getByRole('button')
            .evaluate((button) => button.getBoundingClientRect().height),
        ).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: 'この版を見る（第1版）', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeFocused();
    await expect(page.locator('.doc-box')).toContainText('以前の本文');
    await expect(page.getByRole('cell', { name: '過去の分類', exact: true })).toBeVisible();
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
    await dialog.getByRole('button', { name: '戻す', exact: true }).click();
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
    await expect(page.getByRole('cell', { name: '過去の分類', exact: true })).toBeVisible();
    await page.unroute(operation);
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('第3版');
    await page.getByRole('button', { name: 'この版を見る（第2版）', exact: true }).click();
    await expect(page.locator('.doc-box a', { hasText: '同じページ' })).not.toHaveAttribute('target', '_blank');
    const other = await context.newPage();
    await other.goto(page.url());
    await other.getByRole('button', { name: '編集する', exact: true }).click();
    await other.getByLabel('本文', { exact: true }).fill('# 他の人の本文');
    await other.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(other.getByRole('button', { name: '編集する', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await dialog.getByRole('button', { name: '戻す', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('他の人が先に保存したため、戻せませんでした');
    await expect(page.getByText(/今の版は第[0-9]+版です/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ページへ戻る', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: '版の一覧を読み直す', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'この版に戻す', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'ページへ戻る', exact: true }).click();
    await expect(page.locator('.doc-box')).toContainText('他の人の本文');
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('第4版');
    await expect(rows.first()).toContainText('今の版');
    await page.getByRole('button', { name: 'この版を見る（第2版）', exact: true }).click();
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await dialog.getByRole('button', { name: '戻す', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '第5版として保存しました' })).toBeVisible();
    await expect(page.locator('.doc-box')).toContainText('新しい本文');
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await expect(rows).toHaveCount(5);
    await page.getByRole('button', { name: 'この版を見る（第2版）', exact: true }).click();
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await dialog.getByRole('button', { name: '戻す', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '今の版と同じ内容です。版は足していません。' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await expect(rows).toHaveCount(5);
    for (const width of [320, 390, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.locator(`.wiki-side a[href="${otherPath}"]`).click();
    await expect(page.getByRole('heading', { level: 2, name: '別のページ' })).toBeVisible();
    // 意図して起こした復元競合の409だけを許容し、他のconsole/CSPエラーは引き続き検査する。
    expect(await violations()).toEqual([
      'Failed to load resource: the server responded with a status of 409 (Conflict)',
    ]);
    await other.close();
  });
}

for (const scenario of [
  { scope: 'organization', code: 'not_found', status: 404, text: 'ページが見つからないため戻せませんでした' },
  { scope: 'workspace', code: 'not_found', status: 404, text: 'ページが見つからないため戻せませんでした' },
  { scope: 'workspace', code: 'workspace_closed', status: 409, text: '終了したワークスペースの Wiki は読むだけです。' },
] as const) {
  test(`${scenario.scope}: 復元が${scenario.code}で断られたらページへ戻る操作だけを残す`, async ({ page }) => {
    let root = '/aoba/wiki';
    if (scenario.scope === 'workspace') {
      await createWorkspace(page, 'Wikiの復元を断る');
      root = `${new URL(page.url()).pathname}/wiki`;
    }
    // このケースは拒否後の画面だけを確かめる。保存を繰り返して他ケースと共有する回数の枠を使い切らない。
    const wikiPage = {
      id: crypto.randomUUID(),
      parent_id: null,
      position: 'a0',
      title: '復元を断る手順',
      body_md: '今の本文',
      version: 2,
      created_at: '2026-11-03T00:00:00.000Z',
      updated_at: '2026-11-03T01:00:00.000Z',
    };
    const pageOperation = scenario.scope === 'workspace' ? workspaceWikiPage : orgWikiPage;
    await mockOperation(
      page,
      scenario.scope === 'workspace' ? workspaceWikiTree : orgWikiTree,
      { slug: 'aoba' },
      {
        pages: [
          {
            id: wikiPage.id,
            parent_id: wikiPage.parent_id,
            position: wikiPage.position,
            title: wikiPage.title,
            version: wikiPage.version,
          },
        ],
      },
    );
    let historicalReads = 0;
    await routeOperation(page, pageOperation, { slug: 'aoba' }, async (call) => {
      expect(call.input.page_id).toBe(wikiPage.id);
      let responsePage = wikiPage;
      if (call.input.revision !== undefined) {
        expect(call.input.revision).toBe(1);
        historicalReads++;
        responsePage = {
          ...wikiPage,
          body_md: '前の本文',
          version: 1,
          updated_at: wikiPage.created_at,
        };
      }
      await call.fulfill({ page: responsePage });
    });
    await mockOperation(
      page,
      scenario.scope === 'workspace' ? workspaceWikiRevisions : orgWikiRevisions,
      { slug: 'aoba' },
      {
        revisions: [2, 1].map((version) => ({
          version,
          title: wikiPage.title,
          saved_by: '019a0000-0000-7000-8000-000000000301',
          saved_by_name: 'ミナト',
          saved_at: version === 1 ? wikiPage.created_at : wikiPage.updated_at,
        })),
      },
    );
    await page.goto(`${root}/${wikiPage.id}`);
    await page.getByRole('button', { name: '版の一覧', exact: true }).click();
    await page.getByRole('button', { name: 'この版を見る（第1版）', exact: true }).click();
    await expect.poll(() => historicalReads).toBe(1);
    await failOperation(
      page,
      scenario.scope === 'workspace' ? workspaceWikiUpdate : orgWikiUpdate,
      { slug: 'aoba' },
      scenario.status,
      scenario.code,
    );
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '戻す', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(scenario.text);
    await expect(page.getByRole('button', { name: 'ページへ戻る', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'この版に戻す', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '版の一覧を読み直す', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '版の一覧へ', exact: true })).toHaveCount(0);
    await expect(page.getByText(/今の版は第[0-9]+版です/)).toHaveCount(0);
    await expect(page.locator('.doc-box')).toContainText('前の本文');
  });
}

test('Wiki の題・本文を全語で探し、結果から開け、0件・上限・失敗から再検索できる', async ({ page }) => {
  const violations = await watchViolations(page);
  await createWorkspace(page, 'Wikiの検索');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  const title = '検索の手順';
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill(title);
  await page.getByLabel('本文', { exact: true }).fill('Release の準備');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/[0-9a-f-]{36}$/);
  const pageUrl = page.url();
  await page.locator('.wiki-main .crumbs a').first().click();
  await expect(page).toHaveURL(pageUrl.replace(/\/[^/]+$/, ''));
  const query = page.getByRole('searchbox', { name: 'Wiki の題と本文を探す', exact: true });
  const results = page.getByRole('navigation', { name: 'Wiki の検索結果', exact: true });
  for (const text of ['検索', 'release', '手順　RELEASE']) {
    await query.fill(text);
    await expect(results.getByRole('link', { name: new RegExp('^' + title) })).toBeVisible();
  }
  for (const width of [320, 390, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(query).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(await violations()).toEqual([]);
  const stopRefreshFailure = await routeOperation(
    page,
    workspaceWikiSearch,
    { slug: new URL(page.url()).pathname.split('/')[1]! },
    (call) => call.fail(429, 'rate_limited'),
  );
  await page.getByRole('button', { name: '探す', exact: true }).click();
  await expect(
    page.getByText('検索の回数の上限に達しました。1分ほど待ってから、もう一度探してください。', { exact: true }),
  ).toBeVisible();
  await expect(results).toHaveCount(0);
  await stopRefreshFailure();
  await page.getByRole('button', { name: '探す', exact: true }).click();
  await expect(results.getByRole('link', { name: new RegExp('^' + title) })).toBeVisible();
  await results.getByRole('link', { name: new RegExp('^' + title) }).click();
  await expect(page).toHaveURL(pageUrl);
  await expect(query).toHaveValue('');
  await expect(page.getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible();
  await query.fill('存在しない語');
  await expect(page.getByText('当たるページはありません。語を変えて探してください。', { exact: true })).toBeVisible();
  await expect(results).toHaveCount(0);
  await query.fill('a b c d e f');
  await expect(query).toHaveAttribute('aria-invalid', 'true');
  await query.fill('　 ');
  await expect(results).toHaveCount(0);
  await expect(query).not.toHaveAttribute('aria-invalid', 'true');
  const stopFailure = await routeOperation(
    page,
    workspaceWikiSearch,
    { slug: new URL(page.url()).pathname.split('/')[1]! },
    (call) => call.fail(500, 'internal'),
  );
  await query.fill('準備');
  await expect(
    page.getByText('検索できませんでした。「探す」を押してもう一度試してください。', { exact: true }),
  ).toBeVisible();
  await stopFailure();
  await page.getByRole('button', { name: '探す', exact: true }).click();
  await expect(results.getByRole('link', { name: new RegExp('^' + title) })).toBeVisible();
  await expect(results.getByText('本文に一致', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '編集する', exact: true }).click();
  await page.getByLabel('本文', { exact: true }).fill('検索に当たらない新しい内容');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByText('当たるページはありません。語を変えて探してください。', { exact: true })).toBeVisible();
  await expect(results).toHaveCount(0);
  for (const [status, code, message] of [
    [429, 'rate_limited', '検索の回数の上限に達しました。1分ほど待ってから、もう一度探してください。'],
    [
      409,
      'wiki_search_limit',
      'この Wiki は検索できる量の上限を超えています。検索欄を空にして、木からページを開いてください。',
    ],
  ] as const) {
    const stop = await routeOperation(
      page,
      workspaceWikiSearch,
      { slug: new URL(page.url()).pathname.split('/')[1]! },
      (call) => call.fail(status, code),
    );
    await query.fill(String(status));
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await stop();
  }
  await query.fill('');
  await expect(page.getByRole('navigation', { name: 'ワークスペースの Wiki のページ', exact: true })).toBeVisible();
});

test('遅い検索の応答が、新しい語の0件表示を上書きしない', async ({ page }) => {
  await createWorkspace(page, 'Wiki検索の応答順');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const firstRequest = new Promise<void>((resolve) => {
    started = resolve;
  });
  await routeOperation(
    page,
    workspaceWikiSearch,
    { slug: new URL(page.url()).pathname.split('/')[1]! },
    async (call) => {
      if (call.input.query === '古い語') {
        started?.();
        await waiting;
        await call.fulfill({
          pages: [{ id: '019a0000-0000-7000-8000-000000000001', title: '古い結果', matched_in: 'title' }],
        });
      } else await call.passThrough();
    },
  );
  const query = page.getByRole('searchbox', { name: 'Wiki の題と本文を探す', exact: true });
  await query.fill('古い語');
  await firstRequest;
  await query.fill('新しい語');
  await expect(page.getByText('当たるページはありません。語を変えて探してください。', { exact: true })).toBeVisible();
  const completed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/workspace-wiki-search') && response.request().postDataJSON().query === '古い語',
  );
  release?.();
  await (await completed).finished();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page.getByRole('navigation', { name: 'Wiki の検索結果', exact: true })).toHaveCount(0);
  await expect(query).toHaveValue('新しい語');
});

test('同じ題の検索結果を親の道筋で区別し、現在のページを示す', async ({ page }) => {
  await createWorkspace(page, 'Wiki検索の道筋');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill('同じ手順');
  await page.getByLabel('本文', { exact: true }).fill('最上段の本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('button', { name: '子のページを足す', exact: true })).toBeVisible();
  const parentUrl = page.url();
  await page.getByRole('button', { name: '子のページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill('同じ手順');
  await page.getByLabel('本文', { exact: true }).fill('子だけの本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: '同じ手順', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Wiki の題と本文を探す', exact: true }).fill('同じ手順');
  const results = page.getByRole('navigation', { name: 'Wiki の検索結果', exact: true });
  await expect(results.getByRole('link')).toHaveCount(2);
  await expect(results.locator('a[aria-current="page"]').locator('.props-note').first()).toHaveText('Wiki / 同じ手順');
  await results
    .getByRole('link')
    .filter({ has: page.getByText('Wiki', { exact: true }) })
    .click();
  await expect(page).toHaveURL(parentUrl);
  await expect(page.locator('.doc-box')).toContainText('最上段の本文');
  await page.getByRole('searchbox', { name: 'Wiki の題と本文を探す', exact: true }).fill('');
  // 検索前に子のページを見て開いていた枝を、検索後も保つ。
  await expect(
    page.getByRole('navigation', { name: 'ワークスペースの Wiki のページ', exact: true }).getByRole('link'),
  ).toHaveCount(2);
});

test('組織Wikiでも題と本文で探して開け、ワークスペースのWikiには混ざらない', async ({ page }) => {
  const word = `組織検索${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/aoba/wiki');
  await page.getByRole('button', { name: 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill(word);
  await page.getByLabel('本文', { exact: true }).fill('組織だけの本文');
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki\/[0-9a-f-]{36}$/);
  const url = page.url();
  await page.goto('/aoba/wiki');
  await page.getByRole('searchbox', { name: 'Wiki の題と本文を探す', exact: true }).fill(`${word} 本文`);
  const results = page.getByRole('navigation', { name: 'Wiki の検索結果', exact: true });
  await results.getByRole('link', { name: new RegExp('^' + word) }).click();
  await expect(page).toHaveURL(url);
  await expect(page.locator('.doc-box')).toContainText('組織だけの本文');
  await createWorkspace(page, '組織検索との分離');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  await page.getByRole('searchbox', { name: 'Wiki の題と本文を探す', exact: true }).fill(word);
  await expect(page.getByText('当たるページはありません。語を変えて探してください。', { exact: true })).toBeVisible();
});

test('検索の800ms待ち・変換中・空白だけの変更を区別する', async ({ page }) => {
  await createWorkspace(page, 'Wiki検索の入力状態');
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  const calls: string[] = [];
  await routeOperation(
    page,
    workspaceWikiSearch,
    { slug: new URL(page.url()).pathname.split('/')[1]! },
    async (call) => {
      calls.push(call.input.query);
      await call.fulfill({ pages: [] });
    },
  );
  // 送信時点をブラウザで同期的に記録する。Node側のroute到着前に否定の判定が通るのを防ぐ。
  await page.evaluate(() => {
    const state = window as typeof window & { wikiSearchSends: string[] };
    state.wikiSearchSends = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/workspace-wiki-search') && typeof init?.body === 'string')
        state.wikiSearchSends.push((JSON.parse(init.body) as { query: string }).query);
      return originalFetch(...args);
    };
  });
  const sent = () => page.evaluate(() => (window as typeof window & { wikiSearchSends: string[] }).wikiSearchSends);
  const clockStart = Date.now();
  await page.clock.install({ time: new Date(clockStart) });
  await page.clock.pauseAt(new Date(clockStart + 60000));
  const query = page.getByRole('searchbox', { name: 'Wiki の題と本文を探す', exact: true });
  await query.fill('最初');
  await page.clock.fastForward(799);
  expect(await sent()).toEqual([]);
  await page.clock.fastForward(1);
  await expect.poll(() => calls).toEqual(['最初']);
  expect(await sent()).toEqual(['最初']);
  await query.dispatchEvent('compositionstart');
  await query.fill('変換した語');
  await page.clock.fastForward(5000);
  expect(await sent()).toEqual(['最初']);
  await query.dispatchEvent('compositionend');
  await page.clock.fastForward(800);
  await expect.poll(() => calls).toEqual(['最初', '変換した語']);
  await query.fill('  変換した語　');
  await page.clock.fastForward(1600);
  expect(await sent()).toEqual(['最初', '変換した語']);
  await query.dispatchEvent('compositionstart');
  await query.fill('離れた語');
  await query.blur();
  await page.clock.fastForward(800);
  await expect.poll(() => calls).toEqual(['最初', '変換した語', '離れた語']);
});
