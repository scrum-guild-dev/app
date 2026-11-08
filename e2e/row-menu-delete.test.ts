// バックログの行とスプリントのカードの「⋯」の「このタスクを削除する」（#929）。
// 選ぶと確認なしに消え、「取り消す」付きのトーストが出て、押すと戻る。キーボードで選んだときだけ「取り消す」へフォーカスが移り、
// 押した後は戻したタスクの題のリンクへ、Esc で閉じたときは消した行の次の行（無ければ前の行）へ移る。
// 作った人とリーダー以外には出ない（API の can_delete が偽の行）。幅 390px で項目の押せる範囲が足りる。
// 引き出しの削除は task-delete-undo.test.ts。あおば開発の管理者ミナトで、ワークスペースを作ってタスクを足して使う（seed の行を消さない）
import type { Page } from '@playwright/test';
import { sprintBoard, taskColumnMove } from '../src/shared/operations/sprint/index.ts';
import { backlogTree, taskDelete } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import {
  NARROW_VIEWPORT,
  TARGET_SIZE,
  addTaskRow,
  chooseRowAction,
  createWorkspace,
  rowMenuItem,
  rowMenuToggle,
  expectNoA11yViolationsInThemes,
  signIn,
} from './helpers.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };
const DELETE = 'このタスクを削除する';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 「⋯」をキーボードで開いて、削除の項目を Enter で選ぶ
async function deleteByKeyboard(page: Page, title: string) {
  await rowMenuToggle(page, title).focus();
  await page.keyboard.press('Enter');
  await rowMenuItem(page, title, DELETE).focus();
  await page.keyboard.press('Enter');
}

// スプリントを作って始め、スプリントの画面を開く。未着手の列の末尾の空の行でカードを足す
async function startSprintWithCards(page: Page, titles: string[]) {
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const create = page.getByRole('dialog', { name: 'スプリントを作る' });
  await create.getByLabel('開始日').fill('2099-06-01');
  await create.getByLabel('長さ（日）').fill('14');
  await create.getByLabel('名前（任意）').fill('第9回');
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: '始める: スプリント 第9回' }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める' }).click();
  await expect(start).toBeHidden();
  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 第9回' })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'タスクを足す: 未着手' });
  for (const title of titles) {
    await input.fill(title);
    await input.press('Enter');
    await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  }
}

test('バックログの行の「⋯」の末尾に危険色の削除が出て、選ぶと確認なしに消え、「取り消す」で戻る', async ({ page }) => {
  await createWorkspace(page, '行の削除のマウス');
  await addTaskRow(page, 'マウスで消す行');
  await rowMenuToggle(page, 'マウスで消す行').click();
  const items = page.getByRole('menu', { name: '操作: マウスで消す行', exact: true }).getByRole('menuitem');
  // 末尾の項目で、危険色
  await expect(items.last()).toHaveText(DELETE);
  await expect(items.last()).toHaveClass(/is-danger/);
  await items.last().click();

  // 確認のダイアログは挟まず、消えて、「取り消す」付きのトーストが出る
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toasts:visible .toast', { hasText: '「マウスで消す行」を削除しました' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'マウスで消す行', exact: true })).toHaveCount(0);
  // マウスで選んだときは「取り消す」へフォーカスを動かさない
  const undo = page.getByRole('button', { name: '取り消す: マウスで消す行' });
  await expect(undo).not.toBeFocused();

  await undo.click();
  await expect(page.getByRole('status').filter({ hasText: 'タスクを戻しました' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'マウスで消す行', exact: true })).toBeVisible();
});

test('キーボードで選んで消すと「取り消す」へフォーカスが移り、押すと戻した行の題のリンクへ移る', async ({ page }) => {
  await createWorkspace(page, '行の削除の鍵盤');
  await addTaskRow(page, '鍵盤で消す行');
  await deleteByKeyboard(page, '鍵盤で消す行');

  const undo = page.getByRole('button', { name: '取り消す: 鍵盤で消す行' });
  await expect(undo).toBeFocused();
  await expect(page.getByRole('link', { name: '鍵盤で消す行', exact: true })).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'タスクを戻しました' })).toBeVisible();
  await expect(page.getByRole('link', { name: '鍵盤で消す行', exact: true })).toBeFocused();
});

test('「取り消す」にフォーカスがあるとき Esc で閉じると、消した行の次の行（無ければ前の行）へフォーカスが移る', async ({
  page,
}) => {
  await createWorkspace(page, '行の削除の Esc');
  for (const title of ['先頭の行', '真ん中の行', '末尾の行']) await addTaskRow(page, title);

  // 真ん中を消して Esc: 次の行（末尾の行）へ
  await deleteByKeyboard(page, '真ん中の行');
  await expect(page.getByRole('button', { name: '取り消す: 真ん中の行' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '取り消す: 真ん中の行' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '末尾の行', exact: true })).toBeFocused();

  // 末尾を消して Esc: 次の行が無いので前の行（先頭の行）へ
  await deleteByKeyboard(page, '末尾の行');
  await expect(page.getByRole('button', { name: '取り消す: 末尾の行' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: '先頭の行', exact: true })).toBeFocused();
});

test('削除できない行（can_delete が偽）の「⋯」には削除が出ない', async ({ page }) => {
  await createWorkspace(page, '行の削除の権限');
  await addTaskRow(page, '消せない行');
  await rewriteOperation(page, backlogTree, AOBA, (output) => ({
    ...output,
    tasks: output.tasks.map((task) => ({ ...task, can_delete: false })),
    stories: output.stories.map((story) => ({
      ...story,
      tasks: story.tasks.map((task) => ({ ...task, can_delete: false })),
    })),
  }));
  await page.reload();
  await expect(page.getByRole('link', { name: '消せない行', exact: true })).toBeVisible();
  await expect(rowMenuItem(page, '消せない行', DELETE)).toHaveCount(0);
});

test('失敗は理由をトーストで知らせる（403、409、404）', async ({ page }) => {
  await createWorkspace(page, '行の削除の失敗');
  for (const title of ['断られる行', '取り込みの行', '消えた行']) await addTaskRow(page, title);

  const unroute = await failOperation(page, taskDelete, AOBA, 403, 'forbidden');
  await chooseRowAction(page, '断られる行', DELETE);
  await expect(
    page.locator('.toasts:visible .toast', { hasText: '作った人とリーダーだけが削除できます' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '断られる行', exact: true })).toBeVisible();
  await unroute();

  const unrouteConflict = await failOperation(page, taskDelete, AOBA, 409, 'conflict');
  await chooseRowAction(page, '取り込みの行', DELETE);
  await expect(page.locator('.toasts:visible .toast', { hasText: '取り込んだタスクは削除せず' })).toBeVisible();
  await expect(page.getByRole('link', { name: '取り込みの行', exact: true })).toBeVisible();
  await unrouteConflict();

  await failOperation(page, taskDelete, AOBA, 404, 'not_found');
  await chooseRowAction(page, '消えた行', DELETE);
  await expect(page.locator('.toasts:visible .toast', { hasText: 'このタスクは見つかりません' })).toBeVisible();
});

test('スプリントのカードの「⋯」にも削除が出て、キーボードで消すと「取り消す」へ移り、Esc で隣のカードへ移る', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await createWorkspace(page, `カードの削除 ${test.info().repeatEachIndex}-${test.info().retry}`);
  await startSprintWithCards(page, ['上のカード', '真ん中のカード', '下のカード']);

  await rowMenuToggle(page, '真ん中のカード').click();
  const items = page.getByRole('menu', { name: '操作: 真ん中のカード', exact: true }).getByRole('menuitem');
  await expect(items.last()).toHaveText(DELETE);
  await expect(items.last()).toHaveClass(/is-danger/);
  await page.keyboard.press('Escape');

  await deleteByKeyboard(page, '真ん中のカード');
  const undo = page.getByRole('button', { name: '取り消す: 真ん中のカード' });
  await expect(undo).toBeFocused();
  await expect(page.getByRole('link', { name: '真ん中のカード', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: '下のカード', exact: true })).toBeFocused();
});

test('スプリントのカードをマウスで消して「取り消す」で戻すと、スプリントには戻らずバックログに戻る。can_delete が偽のカードには出ない', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await createWorkspace(page, `カードの削除のマウス ${test.info().repeatEachIndex}-${test.info().retry}`);
  await startSprintWithCards(page, ['マウスで消すカード', '消せないカード']);

  await chooseRowAction(page, 'マウスで消すカード', DELETE);
  const undo = page.getByRole('button', { name: '取り消す: マウスで消すカード' });
  await expect(undo).toBeVisible();
  await expect(page.getByRole('link', { name: 'マウスで消すカード', exact: true })).toHaveCount(0);
  await undo.click();
  // 取り消しはスプリントには戻さない（task-restore）。バックログに戻るので、ボードには出ず、戻したことだけを知らせる
  await expect(page.getByRole('status').filter({ hasText: 'タスクを戻しました' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'マウスで消すカード', exact: true })).toHaveCount(0);

  await rewriteOperation(page, sprintBoard, AOBA, (output) => ({
    ...output,
    columns: output.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map((task) => ({ ...task, can_delete: false })),
    })),
  }));
  await page.reload();
  await expect(page.getByRole('link', { name: '消せないカード', exact: true })).toBeVisible();
  await expect(rowMenuItem(page, '消せないカード', DELETE)).toHaveCount(0);
});

test('幅 390px で、削除の項目の押せる範囲が足りている', async ({ page }) => {
  await createWorkspace(page, '行の削除の狭い幅');
  await addTaskRow(page, '狭い幅の行');
  await page.setViewportSize(NARROW_VIEWPORT);
  await rowMenuToggle(page, '狭い幅の行').click();
  const box = await rowMenuItem(page, '狭い幅の行', DELETE).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(TARGET_SIZE);
  expect(box!.width).toBeGreaterThanOrEqual(TARGET_SIZE);
});

test('「⋯」の削除の項目の上に区切りの罫線があり、4つのテーマで axe の違反が出ない', async ({ page }) => {
  await createWorkspace(page, '行の削除の区切り');
  await addTaskRow(page, '区切りの行');
  await rowMenuToggle(page, '区切りの行').click();
  const items = page.getByRole('menu', { name: '操作: 区切りの行', exact: true }).getByRole('menuitem');
  await expect(items.last()).toHaveText(DELETE);
  // 項目の li の上辺に罫線（--color-rule）。先頭の項目には引かない
  const separators = await items.evaluateAll((buttons) =>
    buttons.map((button) => getComputedStyle(button.closest('li')!).borderTopWidth),
  );
  expect(separators.at(-1)).toBe('1px');
  expect(separators[0]).toBe('0px');
  await expectNoA11yViolationsInThemes(page, 'backlog');
});

test('引き出しを開いている間は、背後の行の「⋯」を押せない（開いたまま同じ行から消す操作は起きない）', async ({
  page,
}) => {
  await createWorkspace(page, '行の削除の引き出し');
  await addTaskRow(page, '開いたまま消す行');
  await page.getByRole('link', { name: '開いたまま消す行', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '開いたまま消す行' });
  await expect(drawer).toBeVisible();

  // 引き出しは aria-modal のダイアログで、背後の行へのポインターを受け止める。消すのは引き出しの「このタスクを削除する」から
  await expect(rowMenuToggle(page, '開いたまま消す行').click({ trial: true, timeout: 2000 })).rejects.toThrow(
    'intercepts pointer events',
  );
  await expect(drawer).toBeVisible();
});

test('動かしを送っている最中にカードを消しても、動かしたカードは元の列に見えない', async ({ page }) => {
  test.setTimeout(90_000);
  await createWorkspace(page, `動かし中の削除 ${test.info().repeatEachIndex}-${test.info().retry}`);
  await startSprintWithCards(page, ['動かすカード', '消すカード']);
  const titlesIn = (name: string) =>
    page.locator('.board-col', { has: page.locator('.board-col-name', { hasText: name }) }).locator('.card-title');

  // 動かしの応答を止める。止めている間にもう1枚を消し、止めを外す
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const unroute = await routeOperation(page, taskColumnMove, AOBA, async (call) => {
    await gate;
    await call.passThrough();
  });
  await page.getByRole('article', { name: '動かすカード', exact: true }).press('Alt+ArrowRight');
  await expect(titlesIn('作業中')).toHaveText(['動かすカード']);

  // 読み直し（sprint-board）の回数を数える。削除を送る前に張る
  let boardReads = 0;
  const unrouteBoard = await routeOperation(page, sprintBoard, AOBA, async (call) => {
    boardReads++;
    await call.passThrough();
  });
  await chooseRowAction(page, '消すカード', DELETE);
  await expect(page.locator('.toasts:visible .toast', { hasText: '「消すカード」を削除しました' })).toBeVisible();
  // 動かしが届くまで読み直さない。動かしたカードは作業中のまま、未着手には戻らない
  expect(boardReads).toBe(0);
  await expect(titlesIn('未着手')).not.toContainText(['動かすカード']);
  release();
  await expect.poll(() => boardReads).toBeGreaterThan(0);
  await unrouteBoard();
  await expect(titlesIn('作業中')).toHaveText(['動かすカード']);
  await expect(titlesIn('未着手')).toHaveCount(0);
  await unroute();
});

// #979: 消した後の読み直し（backlog-tree、sprint-board）だけが失敗したとき。load が一覧を null にして画面は読み込みの失敗に替わる。
// 一時のトーストだけで伝えず、見出しの下に何が済んだか（削除はできている）を残し、「もう一度試す」で読み直せたら消える
test('消した後の読み直しが失敗すると、トーストが消えた後も「削除しましたが」の印と「もう一度試す」が残り、読み直せると消える', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await createWorkspace(page, '行の削除の読み直し');
  await addTaskRow(page, '読み直しに落ちる行');
  await addTaskRow(page, '後で開く行');
  const unroute = await failOperation(page, backlogTree, AOBA, 500, 'internal');
  await chooseRowAction(page, '読み直しに落ちる行', DELETE);

  const notice = page.locator('[data-task-reload-note]');
  await expect(notice).toHaveText('タスクは削除しましたが、画面を読み直せませんでした。もう一度試してください。');
  await expect(notice.getByRole('alert')).toBeVisible();
  const retry = page.getByRole('button', { name: 'もう一度試す', exact: true });
  await expect(retry).toBeVisible();
  // トースト（10 秒）が消えた後も、印は残る
  await expect(page.locator('.toasts:visible .toast', { hasText: '「読み直しに落ちる行」を削除しました' })).toHaveCount(
    0,
    { timeout: 20_000 },
  );
  await expect(notice).toBeVisible();
  await expect(retry).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'backlog');

  await unroute();
  await retry.click();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('link', { name: '読み直しに落ちる行', exact: true })).toHaveCount(0);

  // 読めた後に、削除と関係ない読み直し（引き出しで欄を保存した後）が失敗しても、「削除しましたが」は出ない
  await page.getByRole('link', { name: '後で開く行', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '後で開く行' });
  await expect(drawer).toBeVisible();
  const unrouteAgain = await failOperation(page, backlogTree, AOBA, 500, 'internal');
  await drawer.getByLabel('期日').fill('2099-12-31');
  await expect(page.getByRole('heading', { level: 1, name: '読み込めませんでした' })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await unrouteAgain();
});

test('「取り消す」で戻した後の読み直しが失敗すると、「戻しましたが」の印が残る', async ({ page }) => {
  await createWorkspace(page, '行の取り消しの読み直し');
  await addTaskRow(page, '戻して落ちる行');
  await chooseRowAction(page, '戻して落ちる行', DELETE);
  const undo = page.getByRole('button', { name: '取り消す: 戻して落ちる行' });
  await expect(undo).toBeVisible();
  await expect(page.getByRole('link', { name: '戻して落ちる行', exact: true })).toHaveCount(0);

  const unroute = await failOperation(page, backlogTree, AOBA, 500, 'internal');
  await undo.click();
  const notice = page.locator('[data-task-reload-note]');
  await expect(notice).toHaveText('タスクは戻しましたが、画面を読み直せませんでした。もう一度試してください。');

  await unroute();
  await page.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('link', { name: '戻して落ちる行', exact: true })).toBeVisible();
});

test('スプリントのカードを消した後のボードの読み直しが失敗しても、「削除しましたが」の印と「もう一度試す」が残る', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await createWorkspace(page, `カードの削除の読み直し ${test.info().repeatEachIndex}-${test.info().retry}`);
  await startSprintWithCards(page, ['読み直しに落ちるカード', '残るカード']);
  const unroute = await failOperation(page, sprintBoard, AOBA, 500, 'internal');
  await chooseRowAction(page, '読み直しに落ちるカード', DELETE);

  const notice = page.locator('[data-task-reload-note]');
  await expect(notice).toHaveText('タスクは削除しましたが、画面を読み直せませんでした。もう一度試してください。');
  const retry = page.getByRole('button', { name: 'もう一度試す', exact: true });
  await expect(retry).toBeVisible();
  await expectNoA11yViolationsInThemes(page, 'sprint');

  await unroute();
  await retry.click();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 第9回' })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('link', { name: '残るカード', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '読み直しに落ちるカード', exact: true })).toHaveCount(0);
});
