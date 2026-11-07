// 木の空の行: エピックとストーリーを、題を打って Enter だけで作る（#846）。
// 一本道: 最初のストーリーでバックログに木を出す → 木の末尾の「エピックを足す」でエピック → そのエピックの末尾の「ストーリーを足す」で配下のストーリー
// → 木の末尾の「ストーリーを足す」で親のないストーリー。読み直しても同じ位置にある。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 木の末尾の空の行（エピックの配下の行は .tree-children の中にあるので、木の直下だけを指す）
function treeTail(page: Page) {
  return page.locator('.tree > .draft-row');
}

function epicGroup(page: Page, title: string) {
  return page.locator('.tree-group', { has: page.getByRole('link', { name: title, exact: true }) });
}

test('エピックとストーリーを、木の空の行に題を打って Enter で作る。作った行は読み直さずに入り、読み直しても同じ場所にある', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '空の行のワークスペース');

  // 何も無いバックログには木が出ないので、最初の1件は見出しの右のダイアログで作る
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'ストーリーを作る' });
  await dialog.getByLabel('タイトル').fill('最初のストーリー');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();

  // 木の末尾の「エピックを足す」。空のまま Enter を押しても何も作らない
  const epicInput = treeTail(page).getByRole('textbox', { name: 'エピックを足す' });
  await epicInput.press('Enter');
  await expect(page.locator('.tree-row.is-epic')).toHaveCount(0);

  // Esc は書きかけを捨てる
  await epicInput.fill('捨てる題');
  await epicInput.press('Escape');
  await expect(epicInput).toHaveValue('');

  await epicInput.fill('会員ポイント制度を公開する');
  await epicInput.press('Enter');
  const epic = epicGroup(page, '会員ポイント制度を公開する');
  await expect(epic).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'エピックを作りました' })).toBeVisible();
  // 作れたら入力は空に戻り、続けて打てる
  await expect(epicInput).toHaveValue('');
  await expect(epicInput).toBeFocused();
  // 欄の案内文に、何を作る行かが出ている
  await expect(epicInput).toHaveAttribute('placeholder', 'エピックを足す（題を打って Enter）');

  // そのエピックの末尾の「ストーリーを足す」。配下の末尾に入る
  const underEpic = epic.getByRole('textbox', { name: 'ストーリーを足す: 会員ポイント制度を公開する' });
  await underEpic.fill('残高を見せる');
  await underEpic.press('Enter');
  await expect(epic.getByRole('button', { name: '残高を見せる', exact: true })).toBeVisible();
  await underEpic.fill('失効日を見せる');
  await underEpic.press('Enter');
  const titles = epic.locator('.tree-row.is-story .tree-title');
  await expect(titles).toHaveText(['残高を見せる', '失効日を見せる']);

  // 木の末尾の「ストーリーを足す」は、親のないストーリーを作る（エピックの配下には入らない）
  const rootInput = treeTail(page).getByRole('textbox', { name: 'ストーリーを足す' });
  await rootInput.fill('親のないストーリー');
  await rootInput.press('Enter');
  await expect(page.getByRole('button', { name: '親のないストーリー', exact: true })).toBeVisible();
  await expect(epic.getByRole('button', { name: '親のないストーリー', exact: true })).toHaveCount(0);

  // 読み直しても、配下の順と親は同じ
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(epicGroup(page, '会員ポイント制度を公開する').locator('.tree-row.is-story .tree-title')).toHaveText([
    '残高を見せる',
    '失効日を見せる',
  ]);
  await expect(
    epicGroup(page, '会員ポイント制度を公開する').getByRole('button', { name: '親のないストーリー', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '親のないストーリー', exact: true })).toBeVisible();
  expect(await collect()).toEqual([]);
});
