// 上の帯の検索（#855）: Ctrl+K で欄へ移り、画面の名前で絞って選ぶとその画面へ、ワークスペースの画面では
// 「バックログで「…」を探す」の行でバックログの ?q= へ移る。矢印キーで選べ、Esc で閉じて元の場所へフォーカスが戻る。狭い幅でもはみ出さない。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('Ctrl+K で欄へ移り、画面の名前を打って選ぶとその画面へ移る', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '検索の確認');
  const search = page.getByRole('combobox', { name: '画面とタスクを探す' });
  const list = page.getByRole('listbox', { name: '画面とタスクを探す' });
  await expect(list).toBeHidden();

  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  await search.fill('スプリ');
  await expect(list.getByRole('option')).toHaveText(['スプリント', 'バックログで「スプリ」を探す']);
  await expect(page.getByRole('status').filter({ hasText: '2件の候補' })).toBeAttached();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}\/sprint$/);
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント' })).toBeVisible();
  await expect(search).toHaveValue('');
  await expect(list).toBeHidden();
  expect(await collect()).toEqual([]);
});

test('タスクの題を打つと、バックログの ?q= へ送れる', async ({ page }) => {
  await createWorkspace(page, '検索の確認');
  const search = page.getByRole('combobox', { name: '画面とタスクを探す' });
  await search.fill('請求書');
  const option = page.getByRole('option', { name: 'バックログで「請求書」を探す' });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}\?q=%E8%AB%8B%E6%B1%82%E6%9B%B8$/);
  await expect(page.getByRole('searchbox', { name: 'タイトルで探す' })).toHaveValue('請求書');
});

test('矢印キーで候補を選べ、Esc で閉じて元の場所へフォーカスが戻る', async ({ page }) => {
  await page.goto('/aoba');
  const search = page.getByRole('combobox', { name: '画面とタスクを探す' });
  const opener = page.getByRole('button', { name: /アカウントのメニュー$/ });
  await opener.focus();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  const options = page.getByRole('option');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  const first = await options.first().getAttribute('id');
  await expect(search).toHaveAttribute('aria-activedescendant', first ?? '');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(search).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id')) ?? '');
  await search.fill('該当しない言葉');
  await expect(page.getByText('候補がありません').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(search).toHaveValue('');
  await expect(opener).toBeFocused();
});

for (const width of [320, 390, 760]) {
  test(`${width}px でも検索が使え、横にはみ出さない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/aoba');
    const search = page.getByRole('combobox', { name: '画面とタスクを探す' });
    // 760px 以下では欄を虫眼鏡のボタンに畳み、押すとパンくずの行の下に欄を出して欄へフォーカスを移す（#993）
    const toggle = page.getByRole('button', { name: '画面とタスクを探す' });
    await expect(search).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(search).toBeFocused();
    await search.fill('今日');
    const option = page.getByRole('option', { name: '今日やること' });
    await expect(option).toBeVisible();
    const box = await page.getByRole('listbox', { name: '画面とタスクを探す' }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await option.click();
    await expect(page).toHaveURL(/\/aoba$/);
  });
}

test('390px で虫眼鏡から開いた欄は、Esc で畳んで虫眼鏡へフォーカスを戻し、Ctrl+K でも開く（#993）', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/aoba');
  const search = page.getByRole('combobox', { name: '画面とタスクを探す' });
  const toggle = page.getByRole('button', { name: '画面とタスクを探す' });
  await toggle.click();
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  // 開いた欄を虫眼鏡でもう一度押すと畳む（押したときに欄の外へのフォーカスで畳んで開き直さない）
  await toggle.click();
  await expect(search).toBeFocused();
  await toggle.click();
  await expect(search).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});
