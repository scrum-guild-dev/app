import { openCatalog } from './design-samples.ts';
import { expect, test } from './fixtures.ts';

test('見本の引き出し: タブを切り替えても、作り直しても、書きかけのコメントを残し、別のタスクへ移ると捨てる', async ({
  page,
}) => {
  const errors = await openCatalog(page, 'sprint.html');
  const tasks = page.locator('[data-task]');
  const firstId = await tasks.first().getAttribute('data-task');
  const secondId = await tasks.nth(1).getAttribute('data-task');
  expect(secondId).not.toBe(firstId);
  await tasks.first().click();
  const drawer = page.locator('#drawer');
  const comment = drawer.locator('#new-comment');
  await comment.fill('書きかけのコメント');
  // 要素を覚え、タブの切り替えで引き出しが作り直されないこと（同じ要素のままなこと）を確かめる
  const mark = () => comment.evaluate((el) => ((window as unknown as { __kept?: Element }).__kept = el));
  const isKept = () => comment.evaluate((el) => (window as unknown as { __kept?: Element }).__kept === el);
  await mark();
  const comments = drawer.locator('[data-tab="comments"]');
  const history = drawer.locator('[data-tab="history"]');
  const expectTab = async (on: typeof comments, off: typeof comments) => {
    await expect(on).toHaveAttribute('aria-selected', 'true');
    await expect(on).toHaveAttribute('tabindex', '0');
    await expect(on).toBeFocused();
    await expect(off).toHaveAttribute('aria-selected', 'false');
    await expect(off).toHaveAttribute('tabindex', '-1');
  };

  // クリックで往復する
  await history.click();
  await expectTab(history, comments);
  await expect(drawer.locator('#drawer-panel-comments')).toBeHidden();
  await expect(drawer.locator('#drawer-panel-history')).toBeVisible();
  await comments.click();
  await expectTab(comments, history);
  await expect(comment).toHaveValue('書きかけのコメント');
  expect(await isKept()).toBe(true);

  // 矢印キーと End / Home でも、引き出しを作り直さずに切り替わる
  await comments.focus();
  await page.keyboard.press('ArrowRight');
  await expectTab(history, comments);
  await page.keyboard.press('Home');
  await expectTab(comments, history);
  await page.keyboard.press('End');
  await expectTab(history, comments);
  await page.keyboard.press('ArrowLeft');
  await expectTab(comments, history);
  await expect(comment).toHaveValue('書きかけのコメント');
  expect(await isKept()).toBe(true);

  // 引き出しを実際に作り直す操作（狭い幅への切り替えで renderDrawer が走る）でも、書きかけを戻す
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('[data-assist-open]').first()).toBeHidden();
  await expect(page.locator('.mobile-page-tools')).toBeVisible();
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');
  expect(await isKept()).toBe(false);

  // 引き出しの「次のタスク」で移り、書きかけを捨てると、移った先のコメント欄は空になる
  const title = drawer.locator('#drawer-title');
  const firstTitle = await title.textContent();
  expect(firstTitle).toBeTruthy();
  await drawer.locator('[data-drawer-step="1"]').click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(title).not.toHaveText(firstTitle ?? '');
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  // 「前のタスク」で戻っても、捨てた書きかけは戻らない
  await drawer.locator('[data-drawer-step="-1"]').click();
  await expect(title).toHaveText(firstTitle ?? '');
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  await drawer.locator('#new-comment').fill('書きかけのコメント');

  // 書きかけがあるまま、開いているのと同じタスクのリンクを押すと、確かめずに書きかけを残し、コメントのタブへ戻す
  const dialog = page.locator('#dialog');
  await history.click();
  await page.locator(`[data-task="${firstId}"]`).first().dispatchEvent('click');
  await expect(dialog).toBeHidden();
  await expect(comments).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');

  // 引き出しを開いたまま別のタスクのリンク（アシスタントの答えの参照と同じ data-task）を押すと、移る前に確かめる。
  // 引き出しの後ろの行は幕で押せないので、行の data-task に click を送って同じ経路を通す
  const otherTask = page.locator(`[data-task="${secondId}"]`).first();
  const secondTitle = (await otherTask.innerText()).trim();
  expect(secondTitle).toBeTruthy();
  expect(secondTitle).not.toBe(firstTitle);
  await otherTask.dispatchEvent('click');
  await page.getByRole('button', { name: '書き続ける' }).click();
  await expect(title).toHaveText(firstTitle ?? '');
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');
  // 「書き続ける」の後に閉じて捨てると、前に押したタスクへは移らずに閉じる
  await drawer.locator('.drawer-close').click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(drawer).toBeHidden();
  await tasks.first().click();
  await drawer.locator('#new-comment').fill('書きかけのコメント');
  await otherTask.dispatchEvent('click');
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(title).toHaveText(secondTitle);
  await expect(drawer.locator('#new-comment')).toHaveValue('');

  // パレット（Ctrl+K）の答えの参照から別のタスクを開くときは、確認がパレットの上に出る。
  // 「書き続ける」ならパレットを残し、「捨てる」ならパレットを閉じて移る
  await drawer.locator('#new-comment').fill('書きかけのコメント');
  // スマホでは検索とアカウントだけを出すので、見本のアシスタントの操作は広い幅へ戻して確かめる。
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');
  await page.locator('[data-assist-open]').first().focus();
  await page.keyboard.press('Enter');
  const palette = page.locator('#assist-palette');
  await expect(palette).toBeVisible();
  const ask = palette.locator('input, textarea').first();
  await ask.fill('遅れているタスクは');
  await ask.press('Enter');
  const ref = palette.locator(`.assist-refs a[data-task]:not([data-task="${secondId}"])`).first();
  await expect(ref).toBeVisible();
  const refTitle = (await ref.innerText()).trim();
  await ref.click();
  await page.getByRole('button', { name: '書き続ける' }).click();
  await expect(palette).toBeVisible();
  await expect(ref).toBeFocused();
  await expect(title).toHaveText(secondTitle);
  await ref.click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(palette).toBeHidden();
  await expect(title).toHaveText(refTitle);
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  await expect(drawer.locator('.drawer-close')).toBeFocused();
  await drawer.locator('#new-comment').fill('書きかけのコメント');

  // 閉じて別のタスクを開くと、コメント欄は空になる
  await drawer.locator('.drawer-close').click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(drawer).toBeHidden();
  await tasks.nth(1).click();
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('見本のカタログ: 「ストーリーを直す（引き出し）」の入口は、本物の引き出しを開き、カタログの節を壊さない', async ({
  page,
}) => {
  const errors = await openCatalog(page);
  const section = page.locator('#task-drawer');
  const before = await section.locator('.cat-drawer').count();
  expect(before).toBeGreaterThan(0);
  await page.locator('a[data-story-can-delete="false"]').click();
  const drawer = page.locator('aside#drawer');
  await expect(drawer).toBeVisible();
  // 削除できない人の形: 「⋯」に削除は無く、理由が本文の下に出る
  await expect(drawer.getByText('削除できるのは作った人とリーダーです。')).toBeVisible();
  await drawer.locator('.row-menu-btn').click();
  await expect(drawer.locator('.row-menu-list .menu-item')).toHaveText(['親を移す']);
  await page.keyboard.press('Escape');
  await expect(section.locator('.cat-drawer')).toHaveCount(before);
  expect(errors).toEqual([]);
});

test('見本の削除の確認: クリア済みのエピックを配下を残して削除すると断られ、確認は閉じない', async ({ page }) => {
  const errors = await openCatalog(page);
  const dialog = page.locator('#dialog');

  // まとめて削除できる人: 「残す」は最初から選べず、理由が出る。どちらも未選択で、選ぶまで押せず、選ぶと閉じられる
  await page.locator('[data-dialog="deleteEpicCleared"]').click();
  await expect(dialog.getByLabel('配下を親なしで残す')).toBeDisabled();
  await expect(dialog.getByLabel('配下もまとめて削除する')).not.toBeChecked();
  await expect(dialog.locator('.btn.is-danger')).toHaveAttribute('aria-disabled', 'true');
  await dialog.locator('.btn.is-danger').click({ force: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('配下もまとめて削除する').check();
  await expect(dialog.getByLabel('配下を親なしで残す')).toHaveAccessibleDescription(
    /「配下もまとめて削除する」を選ぶか、先に/,
  );
  await dialog.locator('.btn.is-danger').click();
  await expect(dialog).toBeHidden();

  // まとめて削除できない人: どちらも選べず、依頼主かリーダーに頼む文が出て、削除するは押せない
  await page.locator('[data-dialog="deleteEpicClearedLeaderOnly"]').click();
  await expect(dialog.getByLabel('配下を親なしで残す')).toBeDisabled();
  await expect(dialog.getByLabel('配下もまとめて削除する')).toBeDisabled();
  await expect(dialog.getByLabel('配下を親なしで残す')).toHaveAccessibleDescription(
    /に、エピックの完了を取り消してもらってください/,
  );
  await expect(dialog.locator('.btn.is-danger')).toHaveAttribute('aria-disabled', 'true');
  await dialog.locator('.btn.is-danger').click({ force: true });
  await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
});

test('スマホの見本の浮きメニューから組織作成を開ける（#1102）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openCatalog(page, 'today.html');
  await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
  const menu = page.locator('#mobile-menu');
  await expect(menu.getByRole('heading', { name: 'メニュー', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: '閉じる', exact: true })).toBeVisible();
  await menu.locator('.org-menu-button').click();
  await menu.locator('[data-dialog="createMyOrganization"]').click();
  await expect(menu).toBeHidden();
  const create = page.locator('#dialog input').first();
  await expect(create).toBeFocused();
  await create.fill('こもれび工房');
  await expect(create).toHaveValue('こもれび工房');
  expect(errors).toEqual([]);
});

test('見本のカタログ: エピックは引き出しで開き、読み取り専用と削除権限を示す', async ({ page }) => {
  const errors = await openCatalog(page);
  await expect(
    page.locator('[data-dialog="createEpic"], [data-dialog="createStory"], [data-dialog="editEpic"]'),
  ).toHaveCount(0);
  await page.locator('a[data-epic-can-delete="false"]').click();
  const drawer = page.locator('aside#drawer');
  await expect(drawer.getByText('削除できるのは作った人とリーダーです。')).toBeVisible();
  await expect(drawer.locator('.row-menu-btn')).toHaveCount(0);
  await drawer.locator('[data-close-drawer]').click();
  await page.locator('a[data-epic-readonly="true"]').click();
  await expect(drawer.getByText('終了したワークスペースのエピックは、読み取りだけできます')).toBeVisible();
  await expect(drawer.locator('input, textarea, select')).toHaveCount(0);
  await drawer.locator('[data-drawer-mode="center"]').click();
  await expect(drawer.locator('input, textarea, select')).toHaveCount(0);
  expect(errors).toEqual([]);
});
