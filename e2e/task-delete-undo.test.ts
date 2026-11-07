// タスクの削除の取り消し（引き出しの「このタスクを削除する」と、トーストの「取り消す」）。
// キーボードだけの人が10秒で取り逃さない扱い（#900）: キーボードで消したときだけ「取り消す」へフォーカスを移し、押したら戻したタスクの
// 題のリンクへ、Esc で閉じたら消した行の近い所へ移す。一時的な失敗の出し直し、続けて消したときの読み上げの名前も確かめる。
// あおば開発の管理者ミナトで、ワークスペースを作ってタスクを足して使う（seed の行を消さない）
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';
import { taskDelete } from '../src/shared/operations/task/task-delete.ts';
import { taskRestore } from '../src/shared/operations/task/task-restore.ts';

const AOBA = { slug: 'aoba' };

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

async function addTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '起票' }).click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill(title);
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog).toBeHidden();
}

// 行の題のリンクで引き出しを開く（キーボードの人と同じく、フォーカスを置いて Enter）
async function openByKeyboard(page: Page, title: string) {
  const link = page.getByRole('link', { name: title, exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  return drawer;
}

function deleteButton(drawer: Locator) {
  return drawer.getByRole('button', { name: 'このタスクを削除する' });
}

test('キーボードで削除すると「取り消す」へフォーカスが移り、押すと戻したタスクの題のリンクへ移る', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しの鍵盤');
  await addTask(page, '鍵盤で消す');
  const drawer = await openByKeyboard(page, '鍵盤で消す');
  await deleteButton(drawer).focus();
  await page.keyboard.press('Enter');

  const undo = page.getByRole('button', { name: '取り消す: 鍵盤で消す' });
  await expect(page.locator('.toasts:visible .toast', { hasText: '「鍵盤で消す」を削除しました' })).toBeVisible();
  await expect(undo).toBeFocused();
  await expect(page.getByRole('link', { name: '鍵盤で消す', exact: true })).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'タスクを戻しました' })).toBeVisible();
  await expect(page.getByRole('link', { name: '鍵盤で消す', exact: true })).toBeFocused();
});

test('「取り消す」にフォーカスがあるとき Esc で閉じると、消した行の次の行（無ければ前の行）へフォーカスが移る', async ({
  page,
}) => {
  await createWorkspace(page, '削除の取り消しの Esc');
  for (const title of ['先頭の行', '真ん中の行', '末尾の行']) await addTask(page, title);

  // 真ん中を消して Esc: 次の行（末尾の行）へ
  let drawer = await openByKeyboard(page, '真ん中の行');
  await deleteButton(drawer).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '取り消す: 真ん中の行' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '取り消す: 真ん中の行' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '末尾の行', exact: true })).toBeFocused();

  // 末尾を消して Esc: 次の行が無いので前の行（先頭の行）へ
  drawer = await openByKeyboard(page, '末尾の行');
  await deleteButton(drawer).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '取り消す: 末尾の行' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: '先頭の行', exact: true })).toBeFocused();
});

test('マウスで削除したときは「取り消す」へフォーカスを移さず、見出しに置く', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しのマウス');
  await addTask(page, 'マウスで消す');
  await page.getByRole('link', { name: 'マウスで消す', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'マウスで消す' })
    .getByRole('button', { name: 'このタスクを削除する' })
    .click();
  const undo = page.getByRole('button', { name: '取り消す: マウスで消す' });
  await expect(undo).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeFocused();
  await expect(undo).not.toBeFocused();
});

test('続けて消すと、「取り消す」の読み上げの名前でどのタスクかが分かる。長いタイトルは折り返す', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しの連続');
  const long = '長いタイトルのタスク '.repeat(8).trim();
  await addTask(page, '一つ目');
  await addTask(page, long);
  for (const title of ['一つ目', long]) {
    await page.getByRole('link', { name: title, exact: true }).click();
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'このタスクを削除する' }).click();
    await expect(page.getByRole('button', { name: `取り消す: ${title}`, exact: true })).toBeVisible();
  }
  // 見える文字は「取り消す」のまま、名前だけが違う
  await expect(page.locator('.toast-action', { hasText: '取り消す' })).toHaveCount(2);
  // 長いタイトルのトーストは、幅に収まって折り返す（横にはみ出さない）
  const toast = page.locator('.toasts:visible .toast', { hasText: '長いタイトルのタスク' });
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(await toast.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await page.getByRole('button', { name: '取り消す: 一つ目', exact: true }).click();
  await expect(page.getByRole('link', { name: '一つ目', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: long, exact: true })).toHaveCount(0);
});

test('取り消しが通信の失敗で落ちたら「取り消す」付きで出し直し、押し直して戻す。403 は出し直さない', async ({
  page,
}) => {
  await createWorkspace(page, '削除の取り消しの出し直し');
  await addTask(page, '出し直すタスク');
  let calls = 0;
  await routeOperation(page, taskRestore, AOBA, async (call) => {
    calls += 1;
    if (calls === 1) await call.abort();
    else if (calls === 2) await call.fail(503, 'internal');
    else await call.passThrough();
  });
  await page.getByRole('link', { name: '出し直すタスク', exact: true }).click();
  await page
    .getByRole('dialog', { name: '出し直すタスク' })
    .getByRole('button', { name: 'このタスクを削除する' })
    .click();

  // 通信の失敗（1回目）も 5xx（2回目）も、同じ「取り消す」付きのトーストで出し直す
  await page.getByRole('button', { name: '取り消す: 出し直すタスク' }).click();
  const retry = page.locator('.toasts:visible .toast', {
    hasText: '取り消せませんでした。通信を確かめて、もう一度試してください',
  });
  await expect(retry).toBeVisible();
  await retry.getByRole('button', { name: '取り消す: 出し直すタスク' }).click();
  await expect(retry).toBeVisible();
  await retry.getByRole('button', { name: '取り消す: 出し直すタスク' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'タスクを戻しました' })).toBeVisible();
  await expect(page.getByRole('link', { name: '出し直すタスク', exact: true })).toBeVisible();
  expect(calls).toBe(3);
});

test('取り消しが 403 や 409 で断られたら、理由を知らせるだけで「取り消す」を出し直さない', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しの断り');
  await addTask(page, '断られるタスク');
  await routeOperation(page, taskRestore, AOBA, (call) => call.fail(403, 'forbidden'));
  await page.getByRole('link', { name: '断られるタスク', exact: true }).click();
  await page
    .getByRole('dialog', { name: '断られるタスク' })
    .getByRole('button', { name: 'このタスクを削除する' })
    .click();
  await page.getByRole('button', { name: '取り消す: 断られるタスク' }).click();
  await expect(
    page.locator('.toasts:visible .toast', { hasText: '削除した人と、作った人とリーダーだけが取り消せます' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /取り消す/ })).toHaveCount(0);
});

test('戻すときに外した参照があれば、成功のトーストにそのことを添える', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しの外した参照');
  await addTask(page, '参照を外すタスク');
  await routeOperation(page, taskRestore, AOBA, async (call) => {
    const output = await call.fetch();
    await call.fulfill({ ...output, cleared: ['story', 'assignee'] });
  });
  await page.getByRole('link', { name: '参照を外すタスク', exact: true }).click();
  await page
    .getByRole('dialog', { name: '参照を外すタスク' })
    .getByRole('button', { name: 'このタスクを削除する' })
    .click();
  await page.getByRole('button', { name: '取り消す: 参照を外すタスク' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'ストーリー、担当は、削除の間に変わったため外しました' }),
  ).toBeVisible();
});

test('削除の応答を待つ間に引き出しを閉じても、トーストの「取り消す」が消したタスクを戻す', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しの途中で閉じる');
  await addTask(page, '待つ間に閉じるタスク');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, taskDelete, AOBA, async (call) => {
    await gate;
    await call.passThrough();
  });
  await page.getByRole('link', { name: '待つ間に閉じるタスク', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '待つ間に閉じるタスク' });
  await drawer.getByRole('button', { name: 'このタスクを削除する' }).click();
  await drawer.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(drawer).toBeHidden();

  release();
  const undo = page.getByRole('button', { name: '取り消す: 待つ間に閉じるタスク' });
  await expect(undo).toBeVisible();
  await expect(page.getByRole('link', { name: '待つ間に閉じるタスク', exact: true })).toHaveCount(0);
  await undo.click();
  await expect(page.getByRole('link', { name: '待つ間に閉じるタスク', exact: true })).toBeVisible();
});

test('取り消しの応答だけが落ちて出し直しても、戻っているので失敗とは告げず、戻したことを知らせる', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しの応答落ち');
  await addTask(page, '応答が落ちるタスク');
  let calls = 0;
  await routeOperation(page, taskRestore, AOBA, async (call) => {
    calls += 1;
    if (calls === 1) {
      // サーバーは戻し終えたが、応答は届かない
      await call.fetch();
      await call.abort();
    } else await call.passThrough();
  });
  await page.getByRole('link', { name: '応答が落ちるタスク', exact: true }).click();
  await page
    .getByRole('dialog', { name: '応答が落ちるタスク' })
    .getByRole('button', { name: 'このタスクを削除する' })
    .click();
  await page.getByRole('button', { name: '取り消す: 応答が落ちるタスク' }).click();
  const retry = page.locator('.toasts:visible .toast', {
    hasText: '取り消せませんでした。通信を確かめて、もう一度試してください',
  });
  await retry.getByRole('button', { name: '取り消す: 応答が落ちるタスク' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'タスクを戻しました' })).toBeVisible();
  await expect(page.locator('.toasts:visible .toast', { hasText: 'ほかの画面で変わったため' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '応答が落ちるタスク', exact: true })).toBeVisible();
});

test('マウスで「取り消す」を押しても、戻した行へフォーカスを移さない', async ({ page }) => {
  await createWorkspace(page, '削除の取り消しのマウス取り消し');
  await addTask(page, 'マウスで戻す');
  await page.getByRole('link', { name: 'マウスで戻す', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'マウスで戻す' })
    .getByRole('button', { name: 'このタスクを削除する' })
    .click();
  await page.getByRole('button', { name: '取り消す: マウスで戻す' }).click();
  const link = page.getByRole('link', { name: 'マウスで戻す', exact: true });
  await expect(link).toBeVisible();
  await expect(link).not.toBeFocused();
});

test('ページ全体で開いて、キーボードで削除すると「取り消す」へ移り、押すと戻したタスクの題のリンクへ移る', async ({
  page,
}) => {
  await createWorkspace(page, '削除の取り消しのページ全体');
  await addTask(page, 'ページで消す');
  const workspacePath = new URL(page.url()).pathname;
  const href = await page.getByRole('link', { name: 'ページで消す', exact: true }).getAttribute('href');
  const taskId = new URL(href!, page.url()).searchParams.get('task');
  await page.goto(`${workspacePath}/tasks/${taskId}`);
  const remove = page.getByRole('button', { name: 'このタスクを削除する' });
  await remove.focus();
  await page.keyboard.press('Enter');
  const undo = page.getByRole('button', { name: '取り消す: ページで消す' });
  await expect(undo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'ページで消す', exact: true })).toBeFocused();
});
