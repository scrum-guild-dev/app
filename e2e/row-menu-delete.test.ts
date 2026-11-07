// バックログの行とスプリントのカードの「⋯」の「このタスクを削除する」（#929）。
// 選ぶと確認なしに消え、「取り消す」付きのトーストが出て、押すと戻る。キーボードで選んだときだけ「取り消す」へフォーカスが移り、
// 押した後は戻したタスクの題のリンクへ、Esc で閉じたときは消した行の次の行（無ければ前の行）へ移る。
// 作った人とリーダー以外には出ない（API の can_delete が偽の行）。幅 390px で項目の押せる範囲が足りる。
// 引き出しの削除は task-delete-undo.test.ts。あおば開発の管理者ミナトで、ワークスペースを作ってタスクを足して使う（seed の行を消さない）
import type { Page } from '@playwright/test';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
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
  signIn,
} from './helpers.ts';
import { failOperation, rewriteOperation } from './operations.ts';

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
