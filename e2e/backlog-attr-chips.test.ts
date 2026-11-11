// バックログの行の担当とポイントのチップ（#840）。押すと選択の窓が開き、選ぶと保存して、行と親の集計を直す。
// 一本道: タスクを作る → ポイントのチップで値を選ぶ → 担当のチップで人を選ぶ（アバターと名前が出る）→ キーボードだけで開いて選び、Esc でチップへ戻る
// 親の集計: ストーリーの下のタスクのポイントを選ぶと、親の合計に出る。断られたら理由を出して元の値に戻し、完了にした行のチップは押せず理由が読める。
// 担当: 候補を読んでいる間に開いても Esc でチップへ戻り、読めなければ「担当なし」と「もう一度試す」だけが出る。task-assign が断られたら（タスクが消えた、
// 所属を外れた、競合）理由を出して元の値に戻す。送っている間に選び直したときは、応答を保留して解放し、順序を固定して確かめる。
// 高さだけが変わる resize（スマホのアドレスバー）ではメニューを閉じず、幅が変わると閉じる。
// 見た目（#1158）: 押せるチップは題の後ろに下向きの山形を置き、完了した行のロックしたチップには置かない。ポイントの数は等幅の書体で、
// 長い担当名は 320px・文字150% でも行からはみ出さずに省略する。
// 最後に、選択の窓を開いた状態を4つの見た目で axe にかける。
import { expect, test } from './fixtures.ts';
import { memberList } from '../src/shared/operations/workspace/member-list.ts';
import { backlogTree } from '../src/shared/operations/task/backlog-tree.ts';
import { taskAssign } from '../src/shared/operations/task/task-assign.ts';
import { taskDetail } from '../src/shared/operations/task/task-detail.ts';
import { taskMove } from '../src/shared/operations/task/task-move.ts';
import { taskUpdate } from '../src/shared/operations/task/task-update.ts';
import {
  addStoryRow,
  addTaskRow,
  createWorkspace,
  chooseRowAction,
  expectNoA11yViolationsInThemes,
  signIn,
  waitForResponses,
  waitForSettled,
  watchViolations,
} from './helpers.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';

// 次の描画まで待ってから、画面の高さを返す（resize のイベントは描画の前に届く）
function nextFrameHeight(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(window.innerHeight)));
}

// 応答を保留する門。release() まで、通した操作は本物の API へ流れない
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

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

  // 担当のチップも押せず、理由が読める
  const lockedAssignee = row.getByRole('button', { name: '担当: 未設定' });
  await expect(lockedAssignee).toHaveAttribute('aria-disabled', 'true');
  await lockedAssignee.click({ force: true });
  await expect(page.getByRole('menu')).toHaveCount(0);
  const assigneeReason = await lockedAssignee.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${assigneeReason}"]`)).toContainText('替えられません');
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

  // 応答を保留し、送っている間に「5 pt」から「未見積もり」へ選び直してから解放する
  const held = gate();
  const unroute = await routeOperation(page, taskUpdate, { slug: 'aoba' }, async (call) => {
    await held.wait;
    await call.passThrough();
  });
  // 5 を送り、通った後に未見積もりを送り直す（2本）
  const sent = waitForResponses(page, '/task-update', 2);
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await row.getByRole('button', { name: 'ポイント: 5 pt' }).click();
  await page.getByRole('menuitemradio', { name: '未見積もり', exact: true }).click();
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeVisible();
  held.release();
  await sent;
  await waitForSettled(page);
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeVisible();
  await unroute();

  // 読み直しても未設定（サーバーに 5 が残っていない）
  await page.reload();
  await expect(
    page.locator('.entry', { hasText: '選び直す件' }).getByRole('button', { name: 'ポイント: 未設定' }),
  ).toBeVisible();
});

test('ポイントの保存では木を読み直さず、保存後に元の値へ戻す選択も送る', async ({ page }) => {
  await createWorkspace(page, '読み直しの間のワークスペース');
  await addTaskRow(page, '読み直しの間に選ぶ件');
  const row = page.locator('.entry', { hasText: '読み直しの間に選ぶ件' });
  await waitForSettled(page);

  let treeReads = 0;
  const unroute = await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    treeReads++;
    await call.passThrough();
  });
  const firstSaved = waitForResponses(page, '/task-update');
  const sent = waitForResponses(page, '/task-update', 2);
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await firstSaved;
  await row.getByRole('button', { name: 'ポイント: 5 pt' }).click();
  await page.getByRole('menuitemradio', { name: '未見積もり', exact: true }).click();
  // 保存済みの値を基準に、未見積もりを送り直す
  await sent;
  await waitForSettled(page);
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeVisible();
  expect(treeReads).toBe(0);
  await unroute();

  await page.reload();
  await expect(
    page.locator('.entry', { hasText: '読み直しの間に選ぶ件' }).getByRole('button', { name: 'ポイント: 未設定' }),
  ).toBeVisible();
});

test('担当の保存では木を読み直さず、保存後に担当なしへ戻す選択も送る', async ({ page }) => {
  await createWorkspace(page, '担当の読み直しの間のワークスペース');
  await addTaskRow(page, '担当を読み直しの間に選ぶ件');
  const row = page.locator('.entry', { hasText: '担当を読み直しの間に選ぶ件' });
  await waitForSettled(page);

  let treeReads = 0;
  const unroute = await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    treeReads++;
    await call.passThrough();
  });
  const firstSaved = waitForResponses(page, '/task-assign');
  const sent = waitForResponses(page, '/task-assign', 2);
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const people = page.getByRole('menu', { name: '担当を選ぶ' });
  const member = people.getByRole('menuitemradio').nth(1);
  const name = (await member.innerText()).trim();
  await member.click();
  await firstSaved;
  await row.getByRole('button', { name: `担当: ${name}` }).click();
  await people.getByRole('menuitemradio', { name: '担当なし', exact: true }).click();
  await sent;
  await waitForSettled(page);
  await expect(row.getByRole('button', { name: '担当: 未設定' })).toBeVisible();
  expect(treeReads).toBe(0);
  await unroute();

  await page.reload();
  await expect(
    page.locator('.entry', { hasText: '担当を読み直しの間に選ぶ件' }).getByRole('button', { name: '担当: 未設定' }),
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

test('期日のチップの窓で日付を入れると行に出て、「クリア」で外れる。打ちかけの日付では保存せず窓も閉じない', async ({
  page,
}) => {
  await createWorkspace(page, '期日のワークスペース');
  await addTaskRow(page, '期日を付ける件');
  const row = page.locator('.entry', { hasText: '期日を付ける件' });

  await row.getByRole('button', { name: '期日: 未設定' }).click();
  const panel = page.getByRole('dialog', { name: '期日を選ぶ' });
  const input = panel.getByLabel('期日');
  await expect(input).toBeFocused();
  // 年が4桁そろわない値では保存せず、窓も閉じない
  await input.fill('0002-11-20');
  await expect(panel).toBeVisible();
  await expect(row.getByRole('button', { name: '期日: 未設定' })).toBeVisible();

  const saved = waitForResponses(page, '/task-update');
  await input.fill('2030-11-20');
  await saved;
  await expect(panel).toBeHidden();
  await expect(row.getByRole('button', { name: '期日: 11/20' })).toBeVisible();
  await waitForSettled(page);

  await row.getByRole('button', { name: '期日: 11/20' }).click();
  const cleared = waitForResponses(page, '/task-update');
  await page.getByRole('dialog', { name: '期日を選ぶ' }).getByRole('button', { name: 'クリア' }).click();
  await cleared;
  await expect(row.getByRole('button', { name: '期日: 未設定' })).toBeVisible();
});

test('期日の窓は、続けて日付が変わる間は保存せず、変わらなくなった値を1回だけ保存する', async ({ page }) => {
  await createWorkspace(page, '期日の連続入力のワークスペース');
  await addTaskRow(page, '月を打ち直す件');
  const row = page.locator('.entry', { hasText: '月を打ち直す件' });
  const updates: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/task-update')) updates.push(request.postData() ?? '');
  });

  await row.getByRole('button', { name: '期日: 未設定' }).click();
  const input = page.getByRole('dialog', { name: '期日を選ぶ' }).getByLabel('期日');
  // 月を「1」→「12」と打つと change が2回出る。1回目の値(1月)は保存しない
  await input.fill('2030-01-20');
  await input.fill('2030-12-20');
  await expect(row.getByRole('button', { name: '期日: 12/20' })).toBeVisible();
  await waitForSettled(page);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain('2030-12-20');
});

test('担当の候補を読んでいる間に開いても、Esc で閉じてチップへ戻る', async ({ page }) => {
  await createWorkspace(page, '候補を待つワークスペース');
  await addTaskRow(page, '候補を待つ件');
  const row = page.locator('.entry', { hasText: '候補を待つ件' });

  const held = gate();
  let reads = 0;
  const unroute = await routeOperation(page, memberList, { slug: 'aoba' }, async (call) => {
    reads += 1;
    await held.wait;
    await call.passThrough();
  });
  const chip = row.getByRole('button', { name: '担当: 未設定' });
  await chip.click();
  const menu = page.getByRole('menu', { name: '担当を選ぶ' });
  await expect(menu).toHaveAttribute('aria-busy', 'true');
  await expect(menu.getByRole('menuitem', { name: '読み込んでいます' })).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByRole('menuitemradio', { name: '担当なし', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(chip).toBeFocused();

  // 読み終えた後に開くと、候補を読み直して出す
  held.release();
  await waitForSettled(page);
  await chip.click();
  await expect(menu.getByRole('menuitemradio').nth(1)).toBeVisible();
  await expect(menu).toHaveAttribute('aria-busy', 'false');
  expect(reads).toBe(2);
  await unroute();
});

test('担当を送っている間に元の値へ選び直しても、サーバーの値と行が食い違わない', async ({ page }) => {
  await createWorkspace(page, '担当の選び直しのワークスペース');
  await addTaskRow(page, '担当を選び直す件');
  const row = page.locator('.entry', { hasText: '担当を選び直す件' });

  // 応答を保留し、送っている間に人から「担当なし」へ選び直してから解放する
  const held = gate();
  const unroute = await routeOperation(page, taskAssign, { slug: 'aoba' }, async (call) => {
    await held.wait;
    await call.passThrough();
  });
  // 人を送り、通った後に担当なしを送り直す（2本）
  const sent = waitForResponses(page, '/task-assign', 2);
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const people = page.getByRole('menu', { name: '担当を選ぶ' });
  const member = people.getByRole('menuitemradio').nth(1);
  const name = (await member.innerText()).trim();
  await member.click();
  await row.getByRole('button', { name: `担当: ${name}` }).click();
  await people.getByRole('menuitemradio', { name: '担当なし', exact: true }).click();
  await expect(row.getByRole('button', { name: '担当: 未設定' })).toBeVisible();
  held.release();
  await sent;
  await waitForSettled(page);
  await expect(row.getByRole('button', { name: '担当: 未設定' })).toBeVisible();
  await unroute();

  // 読み直しても未設定（サーバーに選んだ人が残っていない）
  await page.reload();
  await expect(
    page.locator('.entry', { hasText: '担当を選び直す件' }).getByRole('button', { name: '担当: 未設定' }),
  ).toBeVisible();
});

test('担当の保存が断られたら、タスクが消えた、所属を外れた、競合のそれぞれの理由を出して元の値に戻す', async ({
  page,
}) => {
  await createWorkspace(page, '担当が断られるワークスペース');
  await addTaskRow(page, '担当が断られる件');
  const row = page.locator('.entry', { hasText: '担当が断られる件' });
  const chip = row.getByRole('button', { name: '担当: 未設定' });

  async function chooseMember(): Promise<void> {
    await chip.click();
    const people = page.getByRole('menu', { name: '担当を選ぶ' });
    await expect(people).toHaveAttribute('aria-busy', 'false');
    await people.getByRole('menuitemradio').nth(1).click();
  }

  // 404 で、タスクを読み直しても見つからない: タスクが消えた
  let unAssign = await failOperation(page, taskAssign, { slug: 'aoba' }, 404, 'not_found');
  const unDetail = await failOperation(page, taskDetail, { slug: 'aoba' }, 404, 'not_found');
  await chooseMember();
  await expect(page.getByRole('status').filter({ hasText: 'このタスクは見つかりません' })).toBeVisible();
  await expect(chip).toBeVisible();
  await unDetail();
  await unAssign();
  await waitForSettled(page);

  // 404 で、タスクは読める: 選んだ人が所属を外れた
  unAssign = await failOperation(page, taskAssign, { slug: 'aoba' }, 404, 'not_found');
  await chooseMember();
  await expect(page.getByRole('status').filter({ hasText: 'もうこのワークスペースに所属していません' })).toBeVisible();
  await expect(chip).toBeVisible();
  await unAssign();
  await waitForSettled(page);

  // 409 で、タスクは完了していない: ほかの人と同時に直した
  unAssign = await failOperation(page, taskAssign, { slug: 'aoba' }, 409, 'conflict');
  await chooseMember();
  await expect(page.getByRole('status').filter({ hasText: '同時に直した' })).toBeVisible();
  await expect(chip).toBeVisible();
  await unAssign();
});

test('担当の候補を読めなければ「担当なし」だけを選べ、「もう一度試す」で候補が戻る', async ({ page }) => {
  await createWorkspace(page, '候補を読めないワークスペース');
  await addTaskRow(page, '候補を読めない件');
  const row = page.locator('.entry', { hasText: '候補を読めない件' });

  const unroute = await failOperation(page, memberList, { slug: 'aoba' }, 503, 'unavailable');
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const menu = page.getByRole('menu', { name: '担当を選ぶ' });
  const retry = menu.getByRole('menuitem', { name: '担当の候補を読み込めませんでした。もう一度試す' });
  await expect(retry).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1);
  await expect(menu.getByRole('menuitemradio', { name: '担当なし', exact: true })).toBeVisible();

  await unroute();
  await retry.click();
  await expect(menu.getByRole('menuitemradio').nth(1)).toBeVisible();
  await expect(retry).toHaveCount(0);
  // 押した「もう一度試す」が消えても、フォーカスはメニューに残り（選んでいる項目へ移る）、Esc でチップへ戻れる
  await expect(menu.getByRole('menuitemradio', { name: '担当なし', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row.getByRole('button', { name: '担当: 未設定' })).toBeFocused();
});

test('選択の窓は、高さだけが変わっても閉じず、幅が変わると閉じる', async ({ page }) => {
  await createWorkspace(page, '大きさが変わるワークスペース');
  await addTaskRow(page, '大きさが変わる件');
  const row = page.locator('.entry', { hasText: '大きさが変わる件' });
  const size = page.viewportSize();
  if (size === null) throw new Error('画面の大きさが決まっていない');

  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  const menu = page.getByRole('menu', { name: 'ポイントを選ぶ' });
  await expect(menu).toBeVisible();
  // スマホのアドレスバーの出入りと同じく、高さだけを変える
  await page.setViewportSize({ width: size.width, height: size.height - 100 });
  // resize の処理は描画の前に走るので、次の描画を待ってから確かめる
  await expect.poll(() => page.evaluate(nextFrameHeight)).toBe(size.height - 100);
  await expect(menu).toBeVisible();
  // 置き直して、縮んだ画面の中に収まる
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height - 100);

  // 項目にフォーカスがある状態で幅が変わると、閉じて、フォーカスがチップへ戻る（body に落ちない）
  await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
  await page.setViewportSize({ width: size.width - 100, height: size.height - 100 });
  await expect(menu).toBeHidden();
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeFocused();
});

test('担当の候補を読んでいる間と読めなかったときに、常に置いた状態の領域が読み込みと失敗を言い、また失敗したら「まだ読み込めませんでした」を出す', async ({
  page,
}) => {
  await createWorkspace(page, '状態を伝えるワークスペース');
  await addTaskRow(page, '状態を伝える件');
  const row = page.locator('.entry', { hasText: '状態を伝える件' });
  await waitForSettled(page);

  // 読み込み中（member-list を保留）
  const held = gate();
  const unHold = await routeOperation(page, memberList, { slug: 'aoba' }, async (call) => {
    await held.wait;
    await call.passThrough();
  });
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const menu = page.getByRole('menu', { name: '担当を選ぶ' });
  const status = page.locator('[data-attr-chip-status]');
  await expect(status).toHaveText('読み込んでいます');
  await expect(menu).toHaveAttribute('aria-busy', 'true');
  await expectNoA11yViolationsInThemes(page, 'backlog-attr-menu');
  held.release();
  await expect(menu.getByRole('menuitemradio').nth(1)).toBeVisible();
  await expect(status).toHaveText('');
  await unHold();
  await page.keyboard.press('Escape');

  // 読めなかったとき、押してもまた失敗したとき
  const unFail = await failOperation(page, memberList, { slug: 'aoba' }, 503, 'unavailable');
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  await expect(status).toHaveText('担当の候補を読み込めませんでした');
  const retry = menu.getByRole('menuitem', { name: '担当の候補を読み込めませんでした。もう一度試す' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(status).toHaveText('まだ読み込めませんでした');
  await expect(
    menu.getByRole('menuitem', { name: '担当の候補を読み込めませんでした。まだ読み込めませんでした。もう一度試す' }),
  ).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'backlog-attr-menu');

  // 閉じて開き直したら、押していないので「まだ」は出さない
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  await expect(status).toHaveText('担当の候補を読み込めませんでした');
  await expect(retry).toBeVisible();

  // 読めるようになって押すと、候補が戻り、領域は空になる
  await unFail();
  await retry.click();
  await expect(menu.getByRole('menuitemradio').nth(1)).toBeVisible();
  await expect(status).toHaveText('');
});

test('別の行のポイントを保存しても直前の完了の印が残る', async ({ page }) => {
  await createWorkspace(page, '印を保つワークスペース');
  await addTaskRow(page, '先に完了する件');
  await addTaskRow(page, '見積もる件');
  await waitForSettled(page);
  const completed = page.locator('.entry', { hasText: '先に完了する件' });
  const done = waitForResponses(page, '/task-complete');
  await completed.getByRole('button', { name: '完了にする: 先に完了する件', exact: true }).click();
  await done;
  await expect(completed.locator('.hanko')).toBeVisible();
  const saved = waitForResponses(page, '/task-update');
  await page.locator('.entry', { hasText: '見積もる件' }).getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await saved;
  await waitForSettled(page);
  await expect(completed.locator('.hanko')).toBeVisible();
});

test('並べ替えの未送信の分を、別の行のポイントの保存で捨てない', async ({ page }) => {
  await createWorkspace(page, '並べ替えを保つワークスペース');
  await addTaskRow(page, '動かす件');
  await addTaskRow(page, '真ん中の件');
  await addTaskRow(page, '見積もる件');
  await waitForSettled(page);
  const held = gate();
  let moves = 0;
  const unroute = await routeOperation(page, taskMove, { slug: 'aoba' }, async (call) => {
    moves++;
    if (moves === 1) await held.wait;
    await call.passThrough();
  });
  try {
    await chooseRowAction(page, '動かす件', '下へ');
    await expect.poll(() => moves).toBe(1);
    await chooseRowAction(page, '動かす件', '下へ');
    const saved = waitForResponses(page, '/task-update');
    await page.locator('.entry', { hasText: '見積もる件' }).getByRole('button', { name: 'ポイント: 未設定' }).click();
    await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
    await saved;
    await expect(
      page.locator('.entry', { hasText: '見積もる件' }).getByRole('button', { name: 'ポイント: 5 pt' }),
    ).toBeVisible();
  } finally {
    held.release();
  }
  await expect.poll(() => moves).toBe(2);
  await waitForSettled(page);
  await unroute();
  await page.reload();
  await expect(page.locator('.entry-title')).toHaveText(['真ん中の件', '見積もる件', '動かす件']);
});

test('ポイントの送信中に親を移しても、失敗を知らせて最後の選択を保存する', async ({ page }) => {
  await createWorkspace(page, '親を移しても保存するワークスペース');
  await addStoryRow(page, '移す先のストーリー');
  await addTaskRow(page, '移しながら見積もる件');
  await waitForSettled(page);
  const held = gate();
  let updates = 0;
  const unroute = await routeOperation(page, taskUpdate, { slug: 'aoba' }, async (call) => {
    updates++;
    if (updates === 1) {
      await held.wait;
      await call.fail(500, 'internal');
    } else await call.passThrough();
  });
  const row = page.locator('.entry', { hasText: '移しながら見積もる件' });
  try {
    await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
    await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
    await expect.poll(() => updates).toBe(1);
    await chooseRowAction(page, '移しながら見積もる件', '親を移す');
    const dialog = page.getByRole('dialog', { name: '「移しながら見積もる件」の親を移す' });
    await dialog.getByLabel('移す先').selectOption({ label: '移す先のストーリー' });
    const moved = waitForResponses(page, '/task-move');
    await dialog.getByRole('button', { name: '移す', exact: true }).click();
    await moved;
    await expect(dialog).toBeHidden();
    await row.getByRole('button', { name: 'ポイント: 5 pt' }).click();
    await page.getByRole('menuitemradio', { name: '8 pt', exact: true }).click();
    expect(updates).toBe(1);
  } finally {
    held.release();
  }
  await expect(page.getByRole('status').filter({ hasText: '保存できませんでした' })).toBeVisible();
  await expect.poll(() => updates).toBe(2);
  await waitForSettled(page);
  await expect(row.getByRole('button', { name: 'ポイント: 8 pt' })).toBeVisible();
  await unroute();
  await page.reload();
  await expect(row.getByRole('button', { name: 'ポイント: 8 pt' })).toBeVisible();
});

test('絞り込みから外れる担当変更は行を外し、残る完了の印を保つ', async ({ page }) => {
  await createWorkspace(page, '絞り込みを更新する');
  await addTaskRow(page, '印を残す件');
  await addTaskRow(page, '担当を替える件');
  await waitForSettled(page);
  await page.goto(`${new URL(page.url()).pathname}?assignee=none`);
  const completed = page.locator('.entry', { hasText: '印を残す件' });
  const edited = page.locator('.entry', { hasText: '担当を替える件' });
  await completed.getByRole('button', { name: '完了にする: 印を残す件', exact: true }).click();
  await expect(completed.locator('.hanko')).toBeVisible();
  await edited.getByRole('button', { name: '担当: 未設定' }).click();
  const people = page.getByRole('menu', { name: '担当を選ぶ' });
  const reloaded = waitForResponses(page, '/backlog-tree');
  await people.getByRole('menuitemradio', { name: 'ミナト', exact: true }).click();
  await reloaded;
  await expect(edited).toHaveCount(0);
  await expect(completed.locator('.hanko')).toBeVisible();
});

test('押せるチップに山形が出て、完了した行のチップには出ない。ポイントは等幅の書体で、長い担当名は 320px・文字150%で省略する', async ({
  page,
}) => {
  const long = '長い担当名を持つメンバーの名前を省略して表示する確かめの名前';
  // 候補の1人目（このワークスペースを作った人）の名前だけを長くする。DB は書き換えない
  await rewriteOperation(page, memberList, { slug: 'aoba' }, (output) => ({
    ...output,
    members: output.members.map((member, index) => (index === 0 ? { ...member, name: long } : member)),
  }));
  await createWorkspace(page, '山形のワークスペース');
  await addTaskRow(page, '山形を見る件');
  const row = page.locator('.entry', { hasText: '山形を見る件' });

  // 押せる5つのチップ（期日、リポジトリ、区分、ポイント、担当）に、題の後ろの山形が1つずつ出る
  for (const attr of ['期日', 'リポジトリ', '区分', 'ポイント', '担当']) {
    const chip = row.getByRole('button', { name: `${attr}: 未設定` });
    await expect(chip.locator('.ico')).toHaveCount(1);
    await expect(chip.locator('.chip-text + .ico')).toHaveCount(1);
  }

  // ポイントの数は、見本と同じ等幅の書体（--font-mono）で出る
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  const pointSaved = waitForResponses(page, '/task-update');
  await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await pointSaved;
  const points = row.getByRole('button', { name: 'ポイント: 5 pt' });
  const fonts = await points.locator('.chip-text').evaluate((element) => {
    const normalize = (value: string) => value.replace(/["'\s]/g, '');
    return {
      shown: normalize(getComputedStyle(element).fontFamily),
      mono: normalize(getComputedStyle(document.documentElement).getPropertyValue('--font-mono')),
    };
  });
  expect(fonts.mono).not.toBe('');
  expect(fonts.shown).toBe(fonts.mono);

  // 長い名前の人を担当にする
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const assigned = waitForResponses(page, '/task-assign');
  await page.getByRole('menuitemradio', { name: long, exact: true }).click();
  await assigned;
  const assignee = row.getByRole('button', { name: `担当: ${long}` });
  await expect(assignee).toBeVisible();
  await expect(assignee.locator('.ico')).toHaveCount(1);

  // 320px・文字150%: チップは行の幅を超えず、名前を省略する。ページは横にはみ出さない
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => (document.documentElement.style.fontSize = '150%'));
  await page.evaluate(() => document.fonts.ready);
  await assignee.scrollIntoViewIfNeeded();
  const wrapper = row.locator('.attr-chip', { has: assignee });
  const box = (await wrapper.boundingBox())!;
  const bounds = (await row.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(320 + 1);
  const text = await assignee.locator('.chip-text').evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(text.scroll).toBeGreaterThan(text.client);
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);

  // 完了にした行（読み直すまで残る）のロックしたチップ（ポイント、担当）には山形を置かない
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.setViewportSize({ width: 1280, height: 800 });
  await waitForSettled(page);
  await row.getByRole('button', { name: '完了にする: 山形を見る件' }).click();
  await expect(points).toHaveAttribute('aria-disabled', 'true');
  await expect(points.locator('.ico')).toHaveCount(0);
  await expect(assignee).toHaveAttribute('aria-disabled', 'true');
  await expect(assignee.locator('.ico')).toHaveCount(0);
});
