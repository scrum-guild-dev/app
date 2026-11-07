// バックログの行の担当とポイントのチップ（#840）。押すと選択の窓が開き、選ぶと保存して、行と親の集計を直す。
// 一本道: タスクを作る → ポイントのチップで値を選ぶ → 担当のチップで人を選ぶ（アバターと名前が出る）→ キーボードだけで開いて選び、Esc でチップへ戻る
// 親の集計: ストーリーの下のタスクのポイントを選ぶと、親の合計に出る。断られたら理由を出して元の値に戻し、完了にした行のチップは押せず理由が読める。
// 最後に、選択の窓を開いた状態を4つの見た目で axe にかける。
import { expect, test } from './fixtures.ts';
import { taskDetail } from '../src/shared/operations/task/task-detail.ts';
import { taskUpdate } from '../src/shared/operations/task/task-update.ts';
import {
  addStoryRow,
  addTaskRow,
  createWorkspace,
  expectNoA11yViolationsInThemes,
  signIn,
  waitForResponses,
  waitForSettled,
  watchViolations,
} from './helpers.ts';
import { failOperation } from './operations.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('行のチップでポイントと担当を選ぶと、行に出る。キーボードだけで選べ、Esc でチップへ戻る', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'チップのワークスペース');
  await addTaskRow(page, '見積もりを送る');
  const row = page.locator('.entry', { hasText: '見積もりを送る' });

  // 値が無いチップは未設定で、押すと値の一覧が開く
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  const menu = page.getByRole('menu', { name: 'ポイントを選ぶ' });
  await expect(menu.getByRole('menuitemradio', { name: '未見積もり', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const saved = waitForResponses(page, '/task-update');
  await menu.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(row.getByRole('button', { name: 'ポイント: 5 pt' })).toBeFocused();
  await saved;

  // 担当は、候補を読んで選ぶ。行にアバターと名前が出る
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const people = page.getByRole('menu', { name: '担当を選ぶ' });
  await expect(people.getByRole('menuitemradio', { name: '担当なし', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const member = people.getByRole('menuitemradio').nth(1);
  const name = (await member.innerText()).trim();
  const assigned = waitForResponses(page, '/task-assign');
  await member.click();
  await assigned;
  const assigneeChip = row.getByRole('button', { name: `担当: ${name}` });
  await expect(assigneeChip).toBeVisible();
  // アバターは、チップの左隣（同じ .row-menu の中）に出る
  await expect(
    row.locator('.row-menu', { has: page.getByRole('button', { name: `担当: ${name}` }) }).locator('.avatar'),
  ).toHaveCount(1);

  // 読み直しても残る
  await page.reload();
  const again = page.locator('.entry', { hasText: '見積もりを送る' });
  const chip = again.getByRole('button', { name: 'ポイント: 5 pt' });
  await expect(chip).toBeVisible();
  await expect(again.getByRole('button', { name: `担当: ${name}` })).toBeVisible();

  // キーボードだけ: ↓ で開き、Esc は閉じてチップへ戻る。Enter で開き、↓ で動かして Enter で選ぶ
  await chip.focus();
  await page.keyboard.press('ArrowDown');
  const list = page.getByRole('menu', { name: 'ポイントを選ぶ' });
  await expect(list.getByRole('menuitemradio', { name: '5 pt', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(chip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list.getByRole('menuitemradio', { name: '5 pt', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('menuitemradio', { name: '8 pt', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(again.getByRole('button', { name: 'ポイント: 8 pt' })).toBeFocused();

  expect(await collect()).toEqual([]);
});

test('ポイントのチップで選ぶと、親のストーリーの集計に反映される', async ({ page }) => {
  await createWorkspace(page, '集計のワークスペース');
  await addStoryRow(page, '会員の画面');
  await addTaskRow(page, '一覧を出す', '会員の画面');

  const story = page.locator('.tree-row.is-story', { hasText: '会員の画面' });
  await expect(story).toContainText('0 / 0 pt');
  const row = page.locator('.entry', { hasText: '一覧を出す' });
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '3 pt', exact: true }).click();
  await expect(row.getByRole('button', { name: 'ポイント: 3 pt' })).toBeVisible();
  await expect(story).toContainText('0 / 3 pt');
});

test('断られたら理由を出して元の値に戻す。完了にした行のチップは押せず、理由が読める', async ({ page }) => {
  await createWorkspace(page, '断られるワークスペース');
  await addTaskRow(page, '断られる件');
  const row = page.locator('.entry', { hasText: '断られる件' });

  const unroute = await failOperation(page, taskUpdate, { slug: 'aoba' }, 409, 'conflict');
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '2 pt', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '同時に直した' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeVisible();
  await unroute();
  // 断られた後の木の読み直しが終わってから押す（読み直しの途中で完了にすると、完了の印が読み直しに巻き込まれる）
  await waitForSettled(page);

  // 完了にした行（読み直すまで残る）のチップは押せない
  await row.getByRole('button', { name: '完了にする: 断られる件' }).click();
  const locked = row.getByRole('button', { name: 'ポイント: 未設定' });
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled のボタンは Playwright が「押せない」と待つので、押しても開かないことは force で確かめる
  await locked.click({ force: true });
  await expect(page.getByRole('menu')).toHaveCount(0);
  const reason = await locked.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${reason}"]`)).toContainText('直せません');
});

test('担当のチップの選択の窓を開いた状態に axe の違反が無い', async ({ page }) => {
  await createWorkspace(page, '検査のワークスペース');
  await addTaskRow(page, '検査する件');
  const row = page.locator('.entry', { hasText: '検査する件' });
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const menu = page.getByRole('menu', { name: '担当を選ぶ' });
  await expect(menu.getByRole('menuitemradio').nth(1)).toBeVisible();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'backlog-attr-menu');
});

test('送っている間に元の値へ選び直しても、サーバーの値と行が食い違わない', async ({ page }) => {
  await createWorkspace(page, '選び直しのワークスペース');
  await addTaskRow(page, '選び直す件');
  const row = page.locator('.entry', { hasText: '選び直す件' });

  // 応答を遅らせ、送っている間に「5 pt」から「未見積もり」へ選び直す
  await page.route(/\/task-update/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await row.getByRole('button', { name: 'ポイント: 5 pt' }).click();
  await page.getByRole('menuitemradio', { name: '未見積もり', exact: true }).click();
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeVisible();
  await waitForSettled(page);
  await page.unroute(/\/task-update/);

  // 読み直しても未設定（サーバーに 5 が残っていない）
  await page.reload();
  await expect(
    page.locator('.entry', { hasText: '選び直す件' }).getByRole('button', { name: 'ポイント: 未設定' }),
  ).toBeVisible();
});

test('断られた理由を読み直せなかったら、競合とも完了とも言い切らず、保存できなかったと知らせて元の値に戻す', async ({
  page,
}) => {
  await createWorkspace(page, '読めないワークスペース');
  await addTaskRow(page, '読めない件');
  const row = page.locator('.entry', { hasText: '読めない件' });

  const unUpdate = await failOperation(page, taskUpdate, { slug: 'aoba' }, 409, 'conflict');
  const unDetail = await failOperation(page, taskDetail, { slug: 'aoba' }, 500, 'internal');
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '2 pt', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '保存できませんでした' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeVisible();
  await unUpdate();
  await unDetail();
});
