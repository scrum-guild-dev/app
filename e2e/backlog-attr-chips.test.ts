// バックログの行の担当とポイントのチップ（#840）。押すと選択の窓が開き、選ぶと保存して、行と親の集計を直す。
// 一本道: タスクを作る → ポイントのチップで値を選ぶ → 担当のチップで人を選ぶ（アバターと名前が出る）→ キーボードだけで開いて選び、Esc でチップへ戻る
// 親の集計: ストーリーの下のタスクのポイントを選ぶと、親の合計に出る。断られたら理由を出して元の値に戻し、完了にした行のチップは押せず理由が読める。
// 担当: 候補を読んでいる間に開いても Esc でチップへ戻り、読めなければ「担当なし」と「もう一度試す」だけが出る。task-assign が断られたら（タスクが消えた、
// 所属を外れた、競合）理由を出して元の値に戻す。送っている間に選び直したときは、応答を保留して解放し、順序を固定して確かめる。
// 高さだけが変わる resize（スマホのアドレスバー）ではメニューを閉じず、幅が変わると閉じる。
// 最後に、選択の窓を開いた状態を4つの見た目で axe にかける。
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { memberList } from '../src/shared/operations/workspace/member-list.ts';
import { backlogTree } from '../src/shared/operations/task/backlog-tree.ts';
import { taskAssign } from '../src/shared/operations/task/task-assign.ts';
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
import { failOperation, routeOperation } from './operations.ts';

// 次の描画まで待ってから、画面の高さを返す（resize のイベントは描画の前に届く）
function nextFrameHeight(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(window.innerHeight)));
}

// 木の中の、題が title のタスクの欄を書き換える（古い木を返すため）
function withTask<T>(tree: T, title: string, patch: { points?: null; assignee?: null }): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const entries = Object.entries(value).map(([key, item]) => [key, walk(item)] as const);
    const object = Object.fromEntries(entries) as Record<string, unknown>;
    if (object.title === title && 'points' in object && 'assignee' in object) Object.assign(object, patch);
    return object;
  };
  return walk(tree) as T;
}

// 次の木の読み直しを1本だけ保留し、解放したら、題が title のタスクを patch で古い値に戻した木を返す。読み直しが別の読み直しに
// 置き換えられ、task が古いまま返ったときと同じ形。後の読み直しは、SvelteKit が新しい読み直しに置き換えて取り消すことがあるので、
// 流すのが取り消し後になった失敗は捨てる
async function holdStaleTree(
  page: Page,
  title: string,
  patch: { points?: null; assignee?: null },
): Promise<{ reading: Promise<void>; release: () => void; unroute: () => Promise<void> }> {
  const held = gate();
  let arrived!: () => void;
  const reading = new Promise<void>((resolve) => (arrived = resolve));
  let first = true;
  const unroute = await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    if (!first) {
      await call.passThrough().catch(() => {});
      return;
    }
    first = false;
    arrived();
    await held.wait;
    await call.fulfill(withTask(await call.fetch(), title, patch));
  });
  return { reading, release: held.release, unroute };
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

test('保存が通った後の読み直しの間に元の値へ選び直すと、読み直しが古い木を返しても元の値を送り直す', async ({
  page,
}) => {
  await createWorkspace(page, '読み直しの間のワークスペース');
  await addTaskRow(page, '読み直しの間に選ぶ件');
  const row = page.locator('.entry', { hasText: '読み直しの間に選ぶ件' });
  // 足した後の読み直しが終わってから、木の読み直しを保留する
  await waitForSettled(page);

  // 5 が通った後の木の読み直しを保留し、その間に「未見積もり」へ選び直す。読み直しはこの行を古い値（未設定）のまま返す。
  // 行の task と比べると「保存済み」と誤るので、通った値（5）と比べて送り直す必要がある
  const { reading, release, unroute } = await holdStaleTree(page, '読み直しの間に選ぶ件', { points: null });
  const sent = waitForResponses(page, '/task-update', 2);
  await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
  await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await reading;
  await row.getByRole('button', { name: 'ポイント: 5 pt' }).click();
  await page.getByRole('menuitemradio', { name: '未見積もり', exact: true }).click();
  release();
  // 古い木（未設定）が届いても、未見積もりを送り直す
  await sent;
  await waitForSettled(page);
  await expect(row.getByRole('button', { name: 'ポイント: 未設定' })).toBeVisible();
  await unroute();

  await page.reload();
  await expect(
    page.locator('.entry', { hasText: '読み直しの間に選ぶ件' }).getByRole('button', { name: 'ポイント: 未設定' }),
  ).toBeVisible();
});

test('担当の保存が通った後の読み直しの間に「担当なし」へ選び直すと、読み直しが古い木を返しても送り直す', async ({
  page,
}) => {
  await createWorkspace(page, '担当の読み直しの間のワークスペース');
  await addTaskRow(page, '担当を読み直しの間に選ぶ件');
  const row = page.locator('.entry', { hasText: '担当を読み直しの間に選ぶ件' });
  await waitForSettled(page);

  // 人が通った後の木の読み直しを保留し、その間に「担当なし」へ選び直す。読み直しはこの行を古い値（担当なし）のまま返す
  const { reading, release, unroute } = await holdStaleTree(page, '担当を読み直しの間に選ぶ件', { assignee: null });
  const sent = waitForResponses(page, '/task-assign', 2);
  await row.getByRole('button', { name: '担当: 未設定' }).click();
  const people = page.getByRole('menu', { name: '担当を選ぶ' });
  const member = people.getByRole('menuitemradio').nth(1);
  const name = (await member.innerText()).trim();
  await member.click();
  await reading;
  await row.getByRole('button', { name: `担当: ${name}` }).click();
  await people.getByRole('menuitemradio', { name: '担当なし', exact: true }).click();
  release();
  await sent;
  await waitForSettled(page);
  await expect(row.getByRole('button', { name: '担当: 未設定' })).toBeVisible();
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

  await page.setViewportSize({ width: size.width - 100, height: size.height - 100 });
  await expect(menu).toBeHidden();
});
