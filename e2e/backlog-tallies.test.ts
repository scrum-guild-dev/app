import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn, waitForResponses } from './helpers.ts';
import { backlogTree } from '../src/shared/operations/task/index.ts';
import { routeOperation } from './operations.ts';

// 保留した応答を返し終えてから経路を外す。次のテストへ未完了の fetch を残さない。
async function holdTree(page: Page): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending: Promise<void>[] = [];
  const unroute = await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    const response = gate.then(async () => {
      await call.fulfill(await call.fetch());
    });
    pending.push(response);
    await response;
  });
  return async () => {
    release();
    await Promise.all(pending);
    await unroute();
  };
}

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('4つの集計が見本の順に並び、起票と完了を反映し、絞っても全体の件数を出す', async ({ page }) => {
  await createWorkspace(page, '見出しの件数');
  const tallies = page.locator('.page-head .tally');
  await expect(tallies.locator('dt')).toHaveText([
    '未完了のタスク',
    '詳細 未記入',
    '未見積もり',
    'スプリントに入っていない',
  ]);
  await expect(tallies.locator('dd')).toHaveText(['0', '0', '0', '0']);
  await expect(tallies.locator('.is-warn')).toHaveCount(0);
  await addTaskRow(page, '請求の確認');
  await addTaskRow(page, '手順を書く');
  await expect(tallies.locator('dd')).toHaveText(['2', '2', '2', '2']);
  await expect(tallies.locator('.is-warn dt')).toHaveText(['詳細 未記入', '未見積もり']);

  await page.getByRole('searchbox', { name: 'タイトルで探す' }).fill('請求');
  await expect(page.locator('.tree .entry')).toHaveCount(1);
  await expect(tallies.locator('dd')).toHaveText(['2', '2', '2', '2']);
  await expect(page.getByText('ポイントと件数は、絞る前の全体の値です')).toBeVisible();
  await page.getByRole('button', { name: '完了にする: 請求の確認', exact: true }).click();
  await expect(tallies.locator('dd')).toHaveText(['1', '1', '1', '1']);
});

test('見積もりを保存できたら、木の読み直しを待つ間にも件数を直す', async ({ page }) => {
  await createWorkspace(page, '見積もりの件数');
  await addTaskRow(page, '見積もる作業');
  const tallies = page.locator('.page-head .tally dd');
  await expect(tallies).toHaveText(['1', '1', '1', '1']);

  const finishReading = await holdTree(page);
  try {
    const row = page.locator('.entry', { hasText: '見積もる作業' });
    await row.getByRole('button', { name: 'ポイント: 未設定' }).click();
    const saved = waitForResponses(page, '/task-update');
    await page
      .getByRole('menu', { name: 'ポイントを選ぶ' })
      .getByRole('menuitemradio', { name: '5 pt', exact: true })
      .click();
    await saved;
    await expect(tallies).toHaveText(['1', '1', '0', '1']);
  } finally {
    await finishReading();
  }
  await expect(page.locator('.entry').getByRole('button', { name: 'ポイント: 5 pt' })).toBeVisible();
  await expect(tallies).toHaveText(['1', '1', '0', '1']);
});

test('計画でスプリントへ入れたタスクは、バックログに戻ったとき未割り当ての数から外れる', async ({ page }) => {
  await createWorkspace(page, 'スプリントの件数');
  await addTaskRow(page, '次に取り組む作業');
  await page.getByRole('link', { name: '計画', exact: true }).click();
  await page.getByRole('button', { name: 'スプリントを作る', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'スプリントを作る' });
  await create.getByLabel('開始日').fill('2027-02-01');
  await create.getByLabel('長さ（日）').fill('14');
  await create.getByLabel('名前（任意）').fill('次の予定');
  await create.getByRole('button', { name: '作る', exact: true }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: 'バックログから入れる: スプリント 次の予定' }).click();
  const picker = page.getByRole('dialog', { name: 'スプリント 次の予定 に入れる' });
  await picker.getByRole('checkbox', { name: /^次に取り組む作業/ }).check();
  await picker.getByRole('button', { name: '1 件入れる' }).click();
  await expect(picker).toBeHidden();
  await page.getByRole('link', { name: 'バックログ', exact: true }).click();
  await expect(page.locator('.page-head .tally dd')).toHaveText(['1', '1', '1', '0']);
});

test('絞り込みで隠れる起票も、木の応答が来る前から全体の件数に足す', async ({ page }) => {
  await createWorkspace(page, '絞り込み中の件数');
  await addTaskRow(page, '請求の確認');
  await page.getByRole('searchbox', { name: 'タイトルで探す' }).fill('請求');
  await expect(page).toHaveURL(/q=/);
  await expect(page.locator('.tree .entry')).toHaveCount(1);
  // 起票の応答と、その直後の読み込み開始が同じ時計の値になる場合も二重加算しない。
  await page.evaluate(() => {
    performance.now = () => 100;
  });
  const finishReading = await holdTree(page);
  try {
    const input = page.locator('.tree > .draft-row').getByRole('textbox', { name: 'タスクを足す', exact: true });
    await input.fill('手順を書く');
    const saved = waitForResponses(page, '/task-create');
    await input.press('Enter');
    await saved;
    await expect(page.locator('.page-head .tally dd')).toHaveText(['2', '2', '2', '2']);
    await expect(page.locator('.tree .entry')).toHaveCount(1);
  } finally {
    await finishReading();
  }
  await expect(page.getByText('作りました。絞り込みに当たらないので表示していません')).toBeVisible();
  await expect(page.locator('.page-head .tally dd')).toHaveText(['2', '2', '2', '2']);
});
