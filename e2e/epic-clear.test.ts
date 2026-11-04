// エピックのクリアと取り消し（エピックの画面の「エピックを完了にする」と「完了を取り消す」）と、クリアの演出。
// seed の受託開発チームのエピック「ポイントの交換先を増やす」は、作成者がミナト（管理者）で、配下のストーリーは完了している。
// 書き込みの応答は差し替えて確かめるので、seed の行は書き換えない（ほかのファイルと並べて走るため）。
// 演出は動きを減らす設定（reducedMotion: 'reduce'）では出さず、トーストだけにする
import { epicComplete, epicDetail, epicReopen } from '../src/shared/operations/epic/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, rewriteOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };
const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const EPIC_TITLE = 'ポイントの交換先を増やす';
const CLEARED_AT = '2026-10-22T00:00:00.000Z';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('配下がすべて完了していれば「エピックを完了にする」が押せ、クリアすると演出が1回出て、閉じるとボタンへフォーカスが戻る', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const collect = await watchViolations(page);
  await mockOperation(page, epicComplete, AOBA, {
    epic_id: EPIC_ID,
    completed_at: CLEARED_AT,
    reward_xp: 300,
    recipient_count: 2,
  });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);

  const panel = page.getByRole('region', { name: 'エピックの完了' });
  await expect(panel.getByText('配下のストーリーがすべて完了です。')).toBeVisible();
  const clear = panel.getByRole('button', { name: 'エピックを完了にする' });
  await expect(clear).toHaveAttribute('aria-disabled', 'false');
  await clear.click();

  const celebrate = page.locator('.celebrate');
  await expect(celebrate).toBeVisible();
  await expect(celebrate.locator('.celebrate-title')).toHaveText(EPIC_TITLE);
  await expect(celebrate.locator('.celebrate-reward')).toHaveText('参加者の 2 人に 300 XP');
  const close = celebrate.getByRole('button', { name: '閉じる' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(celebrate).toBeHidden();
  expect(await collect()).toEqual([]);
});

test('動きを減らす設定では演出を出さず、トーストだけで知らせる', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockOperation(page, epicComplete, AOBA, {
    epic_id: EPIC_ID,
    completed_at: CLEARED_AT,
    reward_xp: 300,
    recipient_count: 2,
  });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await page.getByRole('button', { name: 'エピックを完了にする' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toHaveText(
    `${'エピック'}を完了にしました。参加者の 2 人に 300 XP`,
  );
  await expect(page.locator('.celebrate')).toHaveCount(0);
});

test('未完了のストーリーが残っていると押せず、理由を横に出す。配下が無いときも同じ', async ({ page }) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    stories: output.stories.map((story) => ({ ...story, completed_at: null })),
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const panel = page.getByRole('region', { name: 'エピックの完了' });
  await expect(panel.getByText('未完了のストーリーが 1 件残っているあいだは、完了にできません。')).toBeVisible();
  const clear = panel.getByRole('button', { name: 'エピックを完了にする' });
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  await clear.click();
  await expect(page.locator('.celebrate')).toHaveCount(0);

  await page.unrouteAll();
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({ ...output, stories: [] }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(panel.getByText('ストーリーが1件も無いエピックは、完了にできません。')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'エピックを完了にする' })).toHaveAttribute('aria-disabled', 'true');
});

test('クリアしたエピックは「完了を取り消す」が出て、取り消しに演出は出さない。断られたときはトーストで知らせる', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    epic: { ...output.epic, completed_at: CLEARED_AT },
  }));
  await mockOperation(page, epicReopen, AOBA, { epic_id: EPIC_ID });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const panel = page.getByRole('region', { name: 'エピックの完了' });
  await expect(panel.getByRole('button', { name: 'エピックを完了にする' })).toHaveCount(0);
  await panel.getByRole('button', { name: '完了を取り消す' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toContainText('の完了を取り消しました');
  await expect(page.locator('.celebrate')).toHaveCount(0);

  await page.unrouteAll();
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({
    ...output,
    epic: { ...output.epic, completed_at: CLEARED_AT },
  }));
  await failOperation(page, epicReopen, AOBA, 409, 'conflict', { details: { reason: 'not_completed' } });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await page.getByRole('button', { name: '完了を取り消す' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toContainText('このエピックは完了していません');
});
