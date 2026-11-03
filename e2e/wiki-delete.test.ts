import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkspace, findA11yViolations, signIn, watchViolations } from './helpers.ts';
import { resetWikiRateLimits } from './local-d1.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';
import { orgWikiDelete, orgWikiMove, orgWikiTree } from '../src/shared/operations/wiki/index.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';

// 実際に作った親子を消し、ダイアログと保存後の木を同じ流れで確かめる。
test.beforeEach(async ({ context, baseURL }) => {
  await resetWikiRateLimits();
  await signIn(context, baseURL, 'admin');
});

async function add(page: Page, title: string, child = false) {
  await page.getByRole('button', { name: child ? '子のページを足す' : 'ページを足す', exact: true }).click();
  await page.getByLabel('題', { exact: true }).fill(title);
  await page.getByLabel('本文', { exact: true }).fill(`本文 ${title}`);
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible();
  return page.url();
}
const deletion = (page: Page) => page.getByRole('dialog', { name: 'ページを消す', exact: true });

for (const scope of ['organization', 'workspace'] as const) {
  test(`${scope}: 確認をやめると残り、子を親の末尾へ上げて消せる`, async ({ page }) => {
    const violations = await watchViolations(page);
    const failedRequests: { status: number; path: string; input: unknown }[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400)
        failedRequests.push({
          status: response.status(),
          path: new URL(response.url()).pathname,
          input: JSON.parse(response.request().postData() ?? 'null') as unknown,
        });
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    if (scope === 'workspace') await createWorkspace(page, `Wiki削除-${suffix}`);
    const root = scope === 'organization' ? '/aoba/wiki' : new URL(page.url()).pathname + '/wiki';
    await page.goto(root);
    const outerTitle = `外側-${suffix}`;
    const targetTitle = `消す手順-${'長い題'.repeat(20)}-${suffix}`;
    const childTitle = `残す子-${suffix}`;
    const siblingTitle = `既存の兄弟-${suffix}`;
    const outer = await add(page, outerTitle);
    const target = await add(page, targetTitle, true);
    const child = await add(page, childTitle, true);
    await page.goto(outer);
    await add(page, siblingTitle, true);
    await page.goto(target);
    let calls = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('-wiki-delete')) calls++;
    });
    const remove = page.getByRole('button', { name: '消す', exact: true });
    await remove.click();
    const dialog = deletion(page);
    await expect(dialog.getByRole('button', { name: 'やめる', exact: true })).toBeFocused();
    await expect(dialog).toContainText(`子のページ1件は「${outerTitle}」の末尾へ上がります。`);
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(await findA11yViolations(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    expect(calls).toBe(0);
    await remove.click();
    await dialog.getByRole('button', { name: '消す', exact: true }).click();
    await expect(page).toHaveURL(outer);
    expect(calls).toBe(1);
    await expect(page.locator('.toast:visible')).toContainText(`「${targetTitle}」を消しました。`);
    const outerNode = page
      .locator('.wiki-node')
      .filter({ has: page.getByRole('link', { name: outerTitle, exact: true }) })
      .locator('..');
    await expect(outerNode.locator(':scope > ul > li > .wiki-node > a')).toHaveText([siblingTitle, childTitle]);
    await page.goto(child);
    await expect(page.locator('.crumbs')).toContainText(outerTitle);
    await expect(page.locator('.crumbs')).not.toContainText(targetTitle);
    await page.goto(target);
    await expect(page.getByText('ページが見つかりません', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '消す', exact: true })).toHaveCount(0);
    await page.goto(outer);
    await page.getByRole('button', { name: '消す', exact: true }).click();
    await expect(dialog).toContainText('子のページ2件は「最上段」の末尾へ上がります。');
    await dialog.getByRole('button', { name: '消す', exact: true }).click();
    await expect(page).toHaveURL(new URL(root, outer).href);
    await expect(page.locator('.wiki-tree > li > .wiki-node > a').filter({ hasText: new RegExp(suffix) })).toHaveText([
      siblingTitle,
      childTitle,
    ]);
    // 削除直後の再取得2回と、消したURLを明示して開いた1回だけが404になる。
    // エラーを一律に除外せず、操作とページIDを含めて期待した要求に限定する。
    const pagePath = `/api/aoba/${scope === 'organization' ? 'org' : 'workspace'}-wiki-page`;
    const input = (url: string) => ({
      ...(scope === 'workspace' ? { workspace_id: root.split('/')[3]! } : {}),
      page_id: new URL(url).pathname.split('/').at(-1)!,
    });
    expect(failedRequests).toEqual([
      { status: 404, path: pagePath, input: input(target) },
      { status: 404, path: pagePath, input: input(target) },
      { status: 404, path: pagePath, input: input(outer) },
    ]);
    expect(await violations()).toEqual(
      Array.from({ length: 3 }, () => 'Failed to load resource: the server responded with a status of 404 (Not Found)'),
    );
  });
}

test('組織の一般メンバーは人のページに消すボタンがなく、自分のページにはある', async ({ page, context, baseURL }) => {
  await page.goto('/aoba/wiki');
  const adminPage = await add(page, `管理者のページ-${crypto.randomUUID().slice(0, 8)}`);
  await signIn(context, baseURL, 'member');
  await page.goto(adminPage);
  await expect(page.getByRole('button', { name: '編集する', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '消す', exact: true })).toHaveCount(0);
  await add(page, `自分のページ-${crypto.randomUUID().slice(0, 8)}`);
  await expect(page.getByRole('button', { name: '消す', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '消す', exact: true }).click();
  await deletion(page).getByRole('button', { name: '消す', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki$/);
});

test('削除の失敗は理由を残し、再読込み後もページが残る', async ({ page }) => {
  await page.goto('/aoba/wiki');
  const title = `消す権限の変化-${crypto.randomUUID().slice(0, 8)}`;
  const url = await add(page, title);
  const unroute = await failOperation(page, orgWikiDelete, { slug: 'aoba' }, 403, 'forbidden');
  await page.getByRole('button', { name: '消す', exact: true }).click();
  await deletion(page).getByRole('button', { name: '消す', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('このページを消す権限がありません。Wikiを読み直してください。');
  await expect(page.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible();
  expect(page.url()).toBe(url);
  await unroute();
  await page.reload();
  await expect(page.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible();
});

test('削除の送信中はページ移動と書き込みを止め、確定後は親へ移る', async ({ page }) => {
  await page.goto('/aoba/wiki');
  const title = `送信中のページ-${crypto.randomUUID().slice(0, 8)}`;
  const url = await add(page, title);
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    received = resolve;
  });
  await routeOperation(page, orgWikiDelete, { slug: 'aoba' }, async (call) => {
    const output = await call.fetch();
    received();
    await gate;
    await call.fulfill(output);
  });
  await page.getByRole('button', { name: '消す', exact: true }).click();
  await deletion(page).getByRole('button', { name: '消す', exact: true }).click();
  await pending;
  try {
    await expect(page.getByText('ページを消しています', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ページを足す', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.locator('.crumbs').getByRole('link', { name: 'Wiki', exact: true }).click();
    expect(page.url()).toBe(url);
    await expect(page.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible();
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/aoba\/wiki$/);
});

test('終了したワークスペースでは自分のページも消すボタンがない', async ({ page }) => {
  await createWorkspace(page, `終了したWiki-${crypto.randomUUID().slice(0, 8)}`);
  await page.locator('.nav-item', { hasText: /^Wiki$/ }).click();
  const url = await add(page, '終了後に残すページ');
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-11-03T00:00:00.000Z',
  }));
  await page.goto(url);
  await expect(page.getByText('終了したワークスペースの Wiki は読むだけです。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '消す', exact: true })).toHaveCount(0);
});

test('削除済みで木の読み直しが失敗しても削除ボタンを戻さない', async ({ page }) => {
  await page.goto('/aoba/wiki');
  const title = `削除後の読み直し-${crypto.randomUUID().slice(0, 8)}`;
  const url = await add(page, title);
  let calls = 0;
  await routeOperation(page, orgWikiDelete, { slug: 'aoba' }, async (call) => {
    calls++;
    const output = await call.fetch();
    await failOperation(page, orgWikiTree, { slug: 'aoba' }, 500, 'internal');
    await call.fulfill(output);
  });
  await page.getByRole('button', { name: '消す', exact: true }).click();
  await deletion(page).getByRole('button', { name: '消す', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/wiki$/);
  await expect(page.locator('.toast:visible')).toContainText(`「${title}」を消しました。`);
  await expect(page.getByRole('button', { name: '消す', exact: true })).toHaveCount(0);
  expect(calls).toBe(1);
  await page.goto(url);
  await expect(page.getByRole('button', { name: '消す', exact: true })).toHaveCount(0);
  expect(calls).toBe(1);
});

test('確認した親が削除前に変わったら消さず、競合を知らせる', async ({ page }) => {
  await page.goto('/aoba/wiki');
  const suffix = crypto.randomUUID().slice(0, 8);
  const originalParent = await add(page, `元の親-${suffix}`);
  const title = `確認後に移るページ-${suffix}`;
  const url = await add(page, title, true);
  const movedParentTitle = `移った先-${suffix}`;
  const movedParent = await add(page, movedParentTitle);
  await page.goto(url);
  await expect(page.locator('.crumbs')).toContainText(`元の親-${suffix}`);
  const pageId = new URL(url).pathname.split('/').at(-1)!;
  const movedParentId = new URL(movedParent).pathname.split('/').at(-1)!;
  await routeOperation(page, orgWikiDelete, { slug: 'aoba' }, async (call) => {
    // 別の人が先に親を移した状態を、画面を読み直さずに再現する。
    const moved = await page.request.post(operationPath(orgWikiMove, 'aoba'), {
      headers: { Origin: new URL(page.url()).origin },
      data: { page_id: pageId, parent_id: movedParentId },
    });
    expect(moved.status()).toBe(200);
    await call.passThrough();
  });
  await page.getByRole('button', { name: '消す', exact: true }).click();
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === operationPath(orgWikiDelete, 'aoba'),
  );
  await deletion(page).getByRole('button', { name: '消す', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('alert')).toHaveText(
    'ページの状態が変わったため消せませんでした。Wikiを読み直してください。',
  );
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('heading', { name: title, exact: true, level: 2 })).toBeVisible();
  await page.reload();
  await expect(page.locator('.crumbs')).toContainText(movedParentTitle);
  await expect(page.locator('.crumbs').getByRole('link', { name: `元の親-${suffix}`, exact: true })).toHaveCount(0);
  expect(new URL(originalParent).pathname).not.toBe(new URL(movedParent).pathname);
});
