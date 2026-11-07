// ショートカットのヒント（#889）: ⌘（Windows と Linux は Ctrl）を約0.3秒押し続けた間だけ、検索の欄と
// タスクの詳細の前後のボタンの角にキーが出る。別のキー（⌘C など）を押すと出ず、離すと消える。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn } from './helpers.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('検索の欄: 押し続けると出て、離すと消える。⌘C のように別のキーを押すと出ない', async ({ page }) => {
  await page.goto('/aoba');
  const hint = page.locator('.key-hints .key-hint');
  await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeVisible();

  await page.keyboard.down('ControlOrMeta');
  await expect(hint).toHaveCount(1);
  await expect(hint).toHaveText(/^(⌘K|Ctrl K)$/);
  await expect(page.locator('.key-hints')).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.up('ControlOrMeta');
  await expect(hint).toHaveCount(0);

  // 別のキーを一緒に押したときは、待っても出ない（出ないことは、出るはずの時間を待たないと確かめられない）
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('c');
  await page.waitForTimeout(600);
  await expect(hint).toHaveCount(0);
  await page.keyboard.up('ControlOrMeta');
});

test('検索の欄: ポインターを押す、ウィンドウを離れる、スクロールすると消える', async ({ page }) => {
  await page.goto('/aoba');
  const hint = page.locator('.key-hints .key-hint');
  await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeVisible();
  const cancels: Array<() => Promise<unknown>> = [
    () => page.mouse.down().then(() => page.mouse.up()),
    () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
    () => page.evaluate(() => document.dispatchEvent(new Event('scroll'))),
  ];
  for (const cancel of cancels) {
    await page.keyboard.down('ControlOrMeta');
    await expect(hint).toHaveCount(1);
    await cancel();
    await expect(hint).toHaveCount(0);
    await page.keyboard.up('ControlOrMeta');
  }
});

test('タスクの詳細: 前後のボタンの角に [ と ] が出る。押せない端のボタンには出さない', async ({ page }) => {
  await createWorkspace(page, 'ヒントのワークスペース');
  for (const title of ['ヒント 一', 'ヒント 二']) {
    await page.getByRole('button', { name: '起票' }).click();
    const dialog = page.getByRole('dialog', { name: '起票' });
    await dialog.getByLabel('タイトル').fill(title);
    await dialog.getByRole('button', { name: '起票' }).click();
    await expect(dialog).toBeHidden();
  }
  await page.locator('.entry', { hasText: 'ヒント 一' }).getByRole('link', { name: 'ヒント 一' }).click();
  const drawer = page.getByRole('dialog', { name: 'ヒント 一' });
  await expect(drawer).toBeVisible();
  const hint = page.locator('.key-hints .key-hint');

  // 一番上のタスクは前が押せない。次の `]` だけ出る
  await page.keyboard.down('ControlOrMeta');
  await expect(hint).toHaveText([']']);
  await page.keyboard.up('ControlOrMeta');
  await expect(hint).toHaveCount(0);
});
