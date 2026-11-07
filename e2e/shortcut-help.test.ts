// ショートカットの一覧（#892）: 入力欄の外で ? を押すとダイアログで一覧が開き、Esc で閉じてフォーカスが戻る。
// 入力欄に打っているときは開かず、? が文字として入る。ライトとダークのテーマと、狭い幅でも読める。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { applyTheme, createWorkspace, signIn, watchViolations } from './helpers.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 何も無いバックログには木が出ない（空の行は木の末尾にある）。最初の1件を「起票」で作ると木が出る
async function createWorkspaceWithTree(page: Page, name: string): Promise<void> {
  await createWorkspace(page, name);
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '起票', exact: true });
  await dialog.getByLabel('タイトル').fill('最初のタスク');
  await dialog.getByRole('button', { name: '起票', exact: true }).click();
  await expect(dialog).toBeHidden();
}

const help = (page: Page) => page.getByRole('dialog', { name: 'ショートカットの一覧' });
const group = (page: Page, title: string) =>
  help(page).locator('.shortcut-group', { has: page.getByRole('heading', { name: title, exact: true }) });
const rowOf = (page: Page, name: string) =>
  help(page).locator('.shortcut-row', { has: page.getByText(name, { exact: true }) });

test('? で一覧が開き、この画面のキーを上に、どの画面でも効くキーをその下に並べる。Esc で閉じてフォーカスが戻る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspaceWithTree(page, 'キーの一覧');
  const opener = page.getByRole('button', { name: '起票', exact: true });
  await opener.focus();

  await page.keyboard.press('?');
  await expect(help(page)).toBeVisible();
  const groups = help(page).locator('.shortcut-group-title');
  await expect(groups).toHaveText(['この画面', 'どの画面でも']);

  // この画面（バックログ）: c。どの画面でも: 検索、g の移動（今いる画面のバックログは除く）、? 自身
  await expect(group(page, 'この画面').locator('.shortcut-row dt')).toHaveText(['タスクを書く']);
  await expect(group(page, 'どの画面でも').locator('.shortcut-row dt')).toHaveText([
    '画面とタスクを探す',
    'スプリントへ移る',
    '今日やることへ移る',
    'ショートカットの一覧',
  ]);
  await expect(rowOf(page, 'タスクを書く').locator('kbd')).toHaveText('c');
  await expect(rowOf(page, '画面とタスクを探す').locator('kbd')).toHaveText(/^(⌘K|Ctrl K)$/);
  await expect(rowOf(page, 'スプリントへ移る').locator('kbd')).toHaveText('g s');
  await expect(rowOf(page, '今日やることへ移る').locator('kbd')).toHaveText('g t');
  await expect(rowOf(page, 'ショートカットの一覧').locator('kbd')).toHaveText('?');
  await expect(help(page).locator('.shortcut-row', { has: page.getByText('バックログへ移る') })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await collect()).toEqual([]);
});

test('入力欄に打っているときの ? は文字になり、一覧は開かない', async ({ page }) => {
  await createWorkspaceWithTree(page, 'キーの一覧');
  const row = page.locator('.tree > .draft-row').getByRole('textbox', { name: 'タスクを足す' });
  await row.focus();
  await page.keyboard.type('これは?');
  await expect(row).toHaveValue('これは?');
  await expect(help(page)).toBeHidden();
});

test('ダークのテーマと、狭い幅（390px）でも読め、横にはみ出さない', async ({ page }) => {
  await createWorkspaceWithTree(page, 'キーの一覧');
  await applyTheme(page, 'simple_dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('?');
  await expect(help(page)).toBeVisible();
  const sheet = help(page).locator('.dialog-sheet');
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await sheet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(rowOf(page, 'スプリントへ移る').locator('kbd')).toBeVisible();
});

test('スプリントの画面でも開き、c を この画面 に、g b を どの画面でも に並べる。画面が替わったら閉じる', async ({
  page,
}) => {
  await createWorkspaceWithTree(page, 'キーの一覧');
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント' })).toBeVisible();
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('?');
  await expect(help(page)).toBeVisible();
  await expect(group(page, 'この画面').locator('.shortcut-row dt')).toHaveText(['タスクを書く']);
  await expect(
    group(page, 'どの画面でも').locator('.shortcut-row', { hasText: 'バックログへ移る' }).locator('kbd'),
  ).toHaveText('g b');
  await expect(group(page, 'どの画面でも').locator('.shortcut-row', { hasText: 'スプリントへ移る' })).toHaveCount(0);
  await page.goBack();
  await expect(help(page)).toBeHidden();
});
