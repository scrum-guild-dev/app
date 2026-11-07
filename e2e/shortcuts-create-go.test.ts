// 単キーのショートカット（#891）: バックログで c を押すと親なしのタスクの空の行へフォーカスが移り、
// g の次の b / s / t でバックログ、スプリント、今日やることの画面へ移る。入力欄に文字を打っている間は働かない。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn, watchViolations } from './helpers.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 木にタスクが1件ある状態にする（最初の1件は木の末尾の空の行で作る）
async function createWorkspaceWithTree(page: Page, name: string): Promise<void> {
  await createWorkspace(page, name);
  await addTaskRow(page, '最初のタスク');
}

// 木の末尾の、親なしのタスクの空の行
const rootTaskRow = (page: Page) => page.locator('.tree > .draft-row').getByRole('textbox', { name: 'タスクを足す' });

test('バックログで c を押すと、親なしのタスクの空の行にフォーカスが移り、文字は入らない', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspaceWithTree(page, 'キーの確認');
  const row = rootTaskRow(page);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-keyshortcuts', 'c');
  await expect(row).not.toBeFocused();

  await page.keyboard.press('c');
  await expect(row).toBeFocused();
  await expect(row).toHaveValue('');

  // 入力欄に打っている間は、c もただの文字
  await page.keyboard.type('cカレンダー');
  await expect(row).toHaveValue('cカレンダー');
  expect(await collect()).toEqual([]);
});

test('g の次の s / b / t で画面を移る。g だけでは移らない', async ({ page }) => {
  await createWorkspace(page, 'キーの確認');
  const backlogUrl = page.url();

  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}\/sprint$/);
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/aoba$/);
  await expect(page.getByRole('heading', { level: 1, name: '今日やること' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await expect(page).toHaveURL(backlogUrl);

  // メニューの項目が、キーを説明として読み上げに伝える（続けて押すキーは aria-keyshortcuts に書けない）
  await expect(page.getByRole('link', { name: 'スプリント', exact: true })).toHaveAccessibleDescription(
    'ショートカット: g を押してから s を押す',
  );
  await expect(page.getByRole('link', { name: '今日やること', exact: true })).toHaveAccessibleDescription(
    'ショートカット: g を押してから t を押す',
  );
  await expect(page.getByRole('link', { name: 'バックログ', exact: true })).toHaveAccessibleDescription(
    'ショートカット: g を押してから b を押す',
  );
});

test('欄に打っている間の g b は、画面を移さず文字になる', async ({ page }) => {
  await createWorkspaceWithTree(page, 'キーの確認');
  const backlogUrl = page.url();
  const row = rootTaskRow(page);
  await row.click();
  await page.keyboard.type('gb');
  await expect(row).toHaveValue('gb');
  await expect(page).toHaveURL(backlogUrl);
});
