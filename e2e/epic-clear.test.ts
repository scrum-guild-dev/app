// エピックのクリアと取り消し（エピックの画面の「エピックを完了にする」と「完了を取り消す」）と、クリアの演出。
// seed の受託開発チームのエピック「ポイントの交換先を増やす」は、作成者がミナト（管理者）で、配下のストーリーは（タスクは完了しているが）ストーリー自体は完了していないので、
// クリアできる状態は epic-detail の応答を書き換えて作る。
// 書き込みの応答は差し替えて確かめるので、seed の行は書き換えない（ほかのファイルと並べて走るため）。
// 演出は動きを減らす設定（reducedMotion: 'reduce'）では出さず、トーストだけにする
import { epicComplete, epicDelete, epicDetail, epicGet, epicReopen } from '../src/shared/operations/epic/index.ts';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { chooseRowAction, signIn, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, rewriteOperation, routeOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };
const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const EPIC_TITLE = 'ポイントの交換先を増やす';
const CLEARED_AT = '2026-10-22T00:00:00.000Z';

const CLEAR_RESPONSE = { epic_id: EPIC_ID, completed_at: CLEARED_AT, reward_xp: 300, recipient_count: 2 };

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// epic-detail の応答を、本物の応答を1回だけ取って書き換えた値にそろえる。クリアと取り消しの後の読み直しも同じ値を返す
// （読み直しのたびに本物を取りに行くと、応答を差し替えた操作の後の読み直しで、本物の応答が JSON でないと判定されて落ちた）
type Detail = Parameters<Parameters<typeof rewriteOperation<typeof epicDetail>>[3]>[0];
function serveDetail(page: Page, change: (output: Detail) => Detail) {
  let served: Detail | undefined;
  return routeOperation(page, epicDetail, AOBA, async (call) => {
    served ??= change(await call.fetch());
    await call.fulfill(served);
  });
}

// 配下のストーリーをすべて完了にした epic-detail にする
function allStoriesDone(page: Page) {
  return serveDetail(page, (output) => ({
    ...output,
    stories: output.stories.map((story) => ({ ...story, completed_at: story.completed_at ?? CLEARED_AT })),
  }));
}

// クリア済みの epic-detail にする
function clearedEpic(page: Page) {
  return serveDetail(page, (output) => ({
    ...output,
    epic: { ...output.epic, completed_at: CLEARED_AT },
  }));
}

test('配下がすべて完了していれば「エピックを完了にする」が押せ、クリアすると演出が1回出て、Tab は閉じるボタンに留まる', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const collect = await watchViolations(page);
  await allStoriesDone(page);
  await mockOperation(page, epicComplete, AOBA, CLEAR_RESPONSE);
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);

  const panel = page.getByRole('region', { name: 'エピックの完了' });
  await expect(panel.getByText('配下のストーリーはすべて完了になっています。')).toBeVisible();
  const clear = panel.getByRole('button', { name: 'エピックを完了にする' });
  await expect(clear).toHaveAttribute('aria-disabled', 'false');
  await clear.click();

  const celebrate = page.locator('.celebrate');
  await expect(celebrate).toBeVisible();
  await expect(celebrate.locator('.celebrate-title')).toHaveText(EPIC_TITLE);
  await expect(celebrate.locator('.celebrate-reward')).toHaveText('参加者の 2 人に 300 XP');
  const close = celebrate.getByRole('button', { name: '閉じる' });
  await expect(close).toBeFocused();
  // Tab を押しても、背後の画面へフォーカスが出ない
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(celebrate).toBeHidden();
  expect(await collect()).toEqual([]);
});

test('動きを減らす設定では演出を出さず、トーストだけで知らせる', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await allStoriesDone(page);
  await mockOperation(page, epicComplete, AOBA, CLEAR_RESPONSE);
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await page.getByRole('button', { name: 'エピックを完了にする' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toHaveText(
    'エピックを完了にしました。参加者の 2 人に 300 XP',
  );
  await expect(page.locator('.celebrate')).toHaveCount(0);
});

test('未完了のストーリーが残っていると押せず、理由を横に出し、クリアの操作を送らない', async ({ page }) => {
  // 配下のストーリーを1件の未完了にする（seed の状態に頼らない）
  await serveDetail(page, (output) => ({
    ...output,
    stories: output.stories.map((story, index) => ({
      ...story,
      completed_at: index === 0 ? null : story.completed_at,
    })),
  }));
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/epic-complete')) sent.push(request.url());
  });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const panel = page.getByRole('region', { name: 'エピックの完了' });
  await expect(panel.getByText('未完了のストーリーが 1 件残っているあいだは、完了にできません。')).toBeVisible();
  const clear = panel.getByRole('button', { name: 'エピックを完了にする' });
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled の押せないボタン。押しても何も送らず、演出も出ない
  await clear.click({ force: true });
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.celebrate')).toHaveCount(0);
  expect(sent).toEqual([]);
});

test('配下のストーリーが無いエピックは押せず、理由を横に出す', async ({ page }) => {
  await rewriteOperation(page, epicDetail, AOBA, (output) => ({ ...output, stories: [] }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const panel = page.getByRole('region', { name: 'エピックの完了' });
  await expect(panel.getByText('ストーリーが1件も無いエピックは、完了にできません。')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'エピックを完了にする' })).toHaveAttribute('aria-disabled', 'true');
});

test('クリアしたエピックは「完了を取り消す」が出て、取り消しに演出は出さない', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await clearedEpic(page);
  await mockOperation(page, epicReopen, AOBA, { epic_id: EPIC_ID });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  const panel = page.getByRole('region', { name: 'エピックの完了' });
  await expect(panel.getByRole('button', { name: 'エピックを完了にする' })).toHaveCount(0);
  await panel.getByRole('button', { name: '完了を取り消す' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toContainText('の完了を取り消しました');
  await expect(page.locator('.celebrate')).toHaveCount(0);
});

test('取り消しが断られたら、理由ごとにトーストで知らせる', async ({ page }) => {
  await clearedEpic(page);
  await failOperation(page, epicReopen, AOBA, 409, 'conflict', { details: { reason: 'not_completed' } });
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await page.getByRole('button', { name: '完了を取り消す' }).click();
  await expect(page.locator('.toasts:visible .toast').last()).toContainText('このエピックは完了していません');
});

test('クリア済みで配下のあるエピックの削除の確認は、配下を親なしで残すを選べず、理由を出して、まとめて削除が選ばれている', async ({
  page,
}) => {
  await rewriteOperation(page, epicGet, AOBA, (output) => ({ ...output, completed_at: CLEARED_AT }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await page.getByRole('link', { name: 'エピックを直す' }).click();
  const drawer = page.getByRole('dialog', { name: EPIC_TITLE, exact: true });
  await expect(drawer).toBeVisible();
  await chooseRowAction(drawer, EPIC_TITLE, 'このエピックを削除する');
  const confirm = page.getByRole('dialog', { name: 'エピックを削除する' });
  const keep = confirm.getByRole('radio', { name: /配下を親なしで残す/ });
  await expect(keep).toBeDisabled();
  await expect(keep).toHaveAccessibleDescription(
    '完了したエピックは、配下のストーリーを親なしで残して削除できません。「配下もまとめて削除する」を選ぶか、先にエピックの完了を取り消してください。',
  );
  // 取り消せない方を既定で選ばない。選ぶまで「削除する」は押せない
  const all = confirm.getByRole('radio', { name: /配下もまとめて削除する/ });
  await expect(all).not.toBeChecked();
  await expect(keep).not.toBeChecked();
  const submit = confirm.getByRole('button', { name: '削除する' });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await all.check();
  await expect(submit).toHaveAttribute('aria-disabled', 'false');
});

test('クリア済みでまとめて削除もできない人は、削除するを押しても送らない', async ({ page }) => {
  let sent = 0;
  await routeOperation(page, epicDelete, AOBA, async (call) => {
    sent++;
    await call.fulfill({ epic_id: EPIC_ID });
  });
  await rewriteOperation(page, epicGet, AOBA, (output) => ({
    ...output,
    completed_at: CLEARED_AT,
    can_delete_children: false,
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await page.getByRole('link', { name: 'エピックを直す' }).click();
  const drawer = page.getByRole('dialog', { name: EPIC_TITLE, exact: true });
  await expect(drawer).toBeVisible();
  await chooseRowAction(drawer, EPIC_TITLE, 'このエピックを削除する');
  const confirm = page.getByRole('dialog', { name: 'エピックを削除する' });
  await expect(confirm.getByRole('radio', { name: /配下を親なしで残す/ })).toBeDisabled();
  await expect(confirm.getByRole('radio', { name: /配下もまとめて削除する/ })).toBeDisabled();
  const submit = confirm.getByRole('button', { name: '削除する' });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.click({ force: true });
  await page.waitForLoadState('networkidle');
  await expect(confirm).toBeVisible();
  expect(sent).toBe(0);
});

test('読み込んだ後にクリアされたエピックを、配下を残して削除すると断られ、理由を出して確認を閉じない', async ({
  page,
}) => {
  await failOperation(page, epicDelete, AOBA, 409, 'epic_finished');
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await page.getByRole('link', { name: 'エピックを直す' }).click();
  const drawer = page.getByRole('dialog', { name: EPIC_TITLE, exact: true });
  await expect(drawer).toBeVisible();
  await chooseRowAction(drawer, EPIC_TITLE, 'このエピックを削除する');
  const confirm = page.getByRole('dialog', { name: 'エピックを削除する' });
  await expect(confirm.getByRole('radio', { name: /配下を親なしで残す/ })).toBeChecked();
  await confirm.getByRole('button', { name: '削除する' }).click();
  await expect(
    confirm.locator('.field-hint', {
      hasText:
        '完了したエピックは、配下のストーリーを親なしで残して削除できません。「配下もまとめて削除する」を選ぶか、先にエピックの完了を取り消してください。',
    }),
  ).toBeVisible();
  await expect(confirm).toBeVisible();
  // 読み直して、続けて同じ断りを繰り返さないよう「残す」を選べなくする
  const keepAfter = confirm.getByRole('radio', { name: /配下を親なしで残す/ });
  await expect(keepAfter).toBeDisabled();
  await expect(keepAfter).not.toBeChecked();
  await expect(confirm.getByRole('button', { name: '削除する' })).toHaveAttribute('aria-disabled', 'true');
});
