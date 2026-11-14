// 書き込みは差し替え、seed を共有するほかのテストへ影響させない。
import type { Page } from '@playwright/test';
import { epicCancel, epicUncancel, epicDetail } from '../src/shared/operations/epic/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { failOperation, routeOperation } from './operations.ts';

const AOBA = { slug: 'aoba' };
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const PATH = `/aoba/w/019a0000-0000-7000-8000-000000000401/epics/${EPIC_ID}`;
const AT = '2026-10-22T00:00:00.000Z';
type Detail = Parameters<Parameters<typeof routeOperation<typeof epicDetail>>[3]>[0];

async function statefulEpic(page: Page, options: { canceled?: boolean; completed?: boolean; manager?: boolean } = {}) {
  let canceled = options.canceled ?? false;
  let served: Awaited<ReturnType<Detail['fetch']>> | undefined;
  await routeOperation(page, epicDetail, AOBA, async (call) => {
    served ??= await call.fetch();
    await call.fulfill({
      ...served,
      can_manage: options.manager ?? true,
      epic: { ...served.epic, canceled_at: canceled ? AT : null, completed_at: options.completed ? AT : null },
    });
  });
  let cancelCalls = 0;
  await routeOperation(page, epicCancel, AOBA, async (call) => {
    cancelCalls++;
    canceled = true;
    await call.fulfill({ epic_id: EPIC_ID });
  });
  await routeOperation(page, epicUncancel, AOBA, async (call) => {
    canceled = false;
    await call.fulfill({ epic_id: EPIC_ID });
  });
  return () => cancelCalls;
}

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('中止は確認してから送り、中止中は受注・割り振り・報酬・完了の操作が消え、取り消すと戻る', async ({ page }) => {
  const calls = await statefulEpic(page);
  const collect = await watchViolations(page);
  await page.goto(PATH);
  const cancel = page.getByRole('button', { name: 'エピックを中止する', exact: true });
  await cancel.click();
  const confirm = page.getByRole('dialog', { name: 'エピックを中止する' });
  await expect(confirm.getByRole('button', { name: 'やめる' })).toBeFocused();
  await expect(confirm).toContainText('すでに確定した経験値は残ります');
  await page.keyboard.press('Escape');
  await expect(cancel).toBeFocused();
  expect(calls()).toBe(0);
  await cancel.click();
  await confirm.getByRole('button', { name: '中止する', exact: true }).click();
  const undo = page.getByRole('button', { name: '中止を取り消す', exact: true });
  await expect(undo).toBeFocused();
  await expect(page.locator('.chip', { hasText: '中止' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'エピックを完了にする', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '参加者に割り振る', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'クリア報酬を変える', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-party-join]')).toHaveCount(0);
  await undo.click();
  await expect(cancel).toBeFocused();
  await expect(page.getByRole('button', { name: 'エピックを完了にする', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '参加者に割り振る', exact: true })).toBeVisible();
  expect(calls()).toBe(1);
  expect(await collect()).toEqual([]);
});

for (const options of [{ manager: false }, { completed: true }]) {
  test(`中止する権限か未完了の条件を満たさないと操作を出さない ${JSON.stringify(options)}`, async ({ page }) => {
    await statefulEpic(page, options);
    await page.goto(PATH);
    await expect(page.locator('[data-epic-cancel]')).toHaveCount(0);
  });
}

test('狭い画面でも中止の確認と取り消しが使え、横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await statefulEpic(page, { canceled: true });
  await page.goto(PATH);
  await page.getByRole('button', { name: '中止を取り消す', exact: true }).click();
  await page.getByRole('button', { name: 'エピックを中止する', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'エピックを中止する' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('中止が競合で断られたら最新の状態を読み直して理由を知らせる', async ({ page }) => {
  await statefulEpic(page);
  await failOperation(page, epicCancel, AOBA, 409, 'conflict');
  await page.goto(PATH);
  await page.getByRole('button', { name: 'エピックを中止する', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'エピックを中止する' })
    .getByRole('button', { name: '中止する', exact: true })
    .click();
  await expect(page.locator('.toasts:visible .toast').last()).toContainText('ほかの画面で状態が変わりました');
});
