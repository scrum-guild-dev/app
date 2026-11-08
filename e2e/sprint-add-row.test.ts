// スプリントの列の末尾の空の行: 題を打って Enter だけで、そのスプリントのその列にタスクを作る（#835）。
// 一本道: 自分のワークスペースでスプリントを作って始める → スプリントの画面の「未着手」「作業中」の末尾の空の行で作る
// → 列の末尾に並び、続けて打てる → 読み直しても同じ列にある → バックログの木にもスプリントの印つきで出る。
// 完了の列には空の行が無い。ワークスペースを管理の画面から終了して開き直すと、どの列にも空の行が出ない。
// 日本語の変換中の Enter や Esc、空のまま離れたときの振る舞いは DraftRow の共通の部品で、バックログの tree-add-row.test.ts が確かめる。
// ここでは、201 字の題を断る画面の検査だけを重ねる。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { failOperation, routeOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { taskCreate } from '../src/shared/operations/task/index.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

const titlesIn = (page: Page, column: string) =>
  page.getByRole('region', { name: column, exact: true }).locator('.card-title');

test('スプリントの各列の末尾の空の行に題を打って Enter で、その列にタスクが入り、読み直しても同じ。完了の列には行が無い', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  const name = `列で作る見張り番 ${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, name);

  // スプリントを作って始める（入っているタスクは 0 件でも始められる）
  await page.getByRole('link', { name: '計画' }).click();
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const create = page.getByRole('dialog', { name: 'スプリントを作る' });
  await create.getByLabel('開始日').fill('2099-06-01');
  await create.getByLabel('長さ（日）').fill('14');
  await create.getByLabel('名前（任意）').fill('第7回');
  await create.getByRole('button', { name: '作る' }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: '始める: スプリント 第7回' }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める' }).click();
  await expect(start).toBeHidden();

  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 第7回' })).toBeVisible();

  // 完了の列には空の行が無い。ほかの列には、場所の分かる名前で1つずつある
  await expect(page.locator('.board-col > .draft-row')).toHaveCount(3);
  await expect(page.getByRole('region', { name: '完了', exact: true }).locator('.draft-row')).toHaveCount(0);

  // `c` で、完了でない最初の列（未着手）の空の行へフォーカスが移る。キーは、その行だけが読み上げに伝える
  const todoRow = page.getByRole('textbox', { name: 'タスクを足す: 未着手' });
  await expect(todoRow).toHaveAttribute('aria-keyshortcuts', 'c');
  await expect(page.locator('.board-col .draft-row input[aria-keyshortcuts]')).toHaveCount(1);
  await page.keyboard.press('c');
  await expect(todoRow).toBeFocused();
  await expect(todoRow).toHaveValue('');

  // 空の行の案内は、カードの説明に結ぶ動かし方の案内とは別の注記にある
  await expect(page.locator('.action-note', { hasText: '空の行に題を打って Enter を押すと' })).toBeVisible();

  const todoInput = page.getByRole('textbox', { name: 'タスクを足す: 未着手' });
  await expect(todoInput).toHaveAttribute('placeholder', 'タスクを足す');

  // 空のまま Enter では作らない。201 字の題は理由を出して作らない
  await todoInput.press('Enter');
  await expect(titlesIn(page, '未着手')).toHaveCount(0);
  await todoInput.fill('あ'.repeat(201));
  await todoInput.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'タイトルは 200 字までです' })).toBeVisible();
  await expect(titlesIn(page, '未着手')).toHaveCount(0);

  // 未着手の末尾に作り、続けて打てる
  await todoInput.fill('見積もりを送る');
  await todoInput.press('Enter');
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る']);
  await expect(page.getByRole('status').filter({ hasText: '「見積もりを送る」を未着手に足しました' })).toBeVisible();
  await expect(todoInput).toHaveValue('');
  await expect(todoInput).toBeFocused();
  await todoInput.fill('請求書を出す');
  await todoInput.press('Enter');
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る', '請求書を出す']);

  // 別の列の末尾にも作れる。入るのはその列だけ
  const doingInput = page.getByRole('textbox', { name: 'タスクを足す: 作業中' });
  await doingInput.fill('障害の連絡手順を書く');
  await doingInput.press('Enter');
  await expect(titlesIn(page, '作業中')).toHaveText(['障害の連絡手順を書く']);
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る', '請求書を出す']);

  // 読み直しても同じ列と並び
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 第7回' })).toBeVisible();
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る', '請求書を出す']);
  await expect(titlesIn(page, '作業中')).toHaveText(['障害の連絡手順を書く']);

  // バックログの木にも、スプリントの印つきで出る
  const board = page.url();
  await page.getByRole('link', { name: 'バックログ', exact: true }).click();
  const row = page.locator('.entry', { hasText: '障害の連絡手順を書く' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('第7回');
  expect(await collect()).toEqual([]);

  // 管理の画面から終了すると、スプリントの画面を開き直しても空の行は出ない（カードは読める）
  await page.goto('/aoba/admin');
  const workspaceRow = page
    .getByRole('region', { name: 'ワークスペース', exact: true })
    .locator('tbody tr', { hasText: name });
  await workspaceRow.getByRole('button', { name: `「${name}」を終了する` }).click();
  await page
    .getByRole('dialog', { name: `「${name}」を終了しますか？` })
    .getByRole('button', { name: `「${name}」を終了する` })
    .click();
  await expect(workspaceRow.locator('.chip')).toHaveText(/^終了 \d{4}-\d{2}-\d{2}$/);
  await page.goto(board);
  await expect(titlesIn(page, '未着手')).toHaveText(['見積もりを送る', '請求書を出す']);
  await expect(page.locator('.draft-row')).toHaveCount(0);
});

test('作るのが断られたら、作られていないことを行の下に知らせ、書きかけを残して盤面を読み直す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  // sprint-board の呼び出しを数える（断られたら読み直す）
  let boardCalls = 0;
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, async (call) => {
    boardCalls++;
    await call.fulfill(SAMPLE_BOARD);
  });
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401/sprint');
  const input = page.getByRole('textbox', { name: 'タスクを足す: 未着手' });
  await expect(input).toBeVisible();
  const alert = (text: string) => page.getByRole('alert').filter({ hasText: text });

  // 断りの理由ごとに、行の下の文、書きかけの残り、盤面の読み直しを確かめる
  const cases = [
    {
      status: 409,
      code: 'conflict',
      details: { reason: 'closed' },
      text: 'もう進行中ではないので、タスクは作られていません',
    },
    {
      status: 409,
      code: 'conflict',
      details: { reason: 'done_column' },
      text: '完了の列にはタスクを足せないので、作られていません',
    },
    { status: 404, code: 'not_found', details: undefined, text: 'が見つかりません。タスクは作られていません' },
  ] as const;
  for (const { status, code, details, text } of cases) {
    const unroute = await failOperation(
      page,
      taskCreate,
      { slug: 'aoba' },
      status,
      code,
      details === undefined ? undefined : { details },
    );
    const before = boardCalls;
    await input.fill('障害の連絡手順を書く');
    await input.press('Enter');
    await expect(alert(text)).toBeVisible();
    await expect(input).toHaveValue('障害の連絡手順を書く');
    await expect.poll(() => boardCalls).toBeGreaterThan(before);
    await unroute();
    await input.fill('');
  }
});
