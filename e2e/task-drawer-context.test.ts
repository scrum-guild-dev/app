import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn, waitForSettled } from './helpers.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { taskTodayMark } from '../src/shared/operations/task/task-today-mark.ts';
import { taskDetail } from '../src/shared/operations/task/task-detail.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('列と親を表示し、今日やるの印を付け外す', async ({ page }) => {
  await createWorkspace(page, '引き出しの位置');
  await addTaskRow(page, '今日やるを切り替える');
  await rewriteOperation(page, taskDetail, { slug: 'aoba' }, (output) => ({
    ...output,
    column: { id: 'column', name: '作業中', is_done: false },
    story: { id: 'story', title: '見積もりを整える' },
    epic: { id: 'epic', title: '新しい窓口を公開する' },
  }));
  await page.getByRole('link', { name: '今日やるを切り替える', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '今日やるを切り替える' });
  await expect(drawer.locator('.status-dot')).toHaveText('作業中');
  await expect(drawer.getByRole('definition').filter({ hasText: '見積もりを整える' })).toBeVisible();
  await expect(drawer.getByText('新しい窓口を公開する', { exact: true })).toBeVisible();
  const sun = drawer.getByRole('button', { name: '今日やる: 今日やるを切り替える', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'true');
  await expect(drawer.getByText('自分が担当するタスクだけ今日やるの印を付け外しできます')).toBeVisible();
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: 'ミナト' });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await sun.click();
  await expect(sun).toHaveAttribute('aria-pressed', 'true');
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  // 担当を外すと印も消え、本人に戻しても復活しない。
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: '担当なし' });
  await expect(sun).toHaveAttribute('aria-disabled', 'true');
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: 'ミナト' });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  await sun.click();
  await expect(sun).toHaveAttribute('aria-pressed', 'true');
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await sun.click();
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  // 印は詳細の再取得より先に反映される。更新が終わってから後片付けへ進む。
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await waitForSettled(page);
});

test('完了したタスクは理由を添えて今日やるを無効にする', async ({ page }) => {
  await createWorkspace(page, '引き出しの完了');
  await addTaskRow(page, '印を変えない');
  await rewriteOperation(page, taskDetail, { slug: 'aoba' }, (output) => ({
    ...output,
    column:
      output.task.completed_at === null
        ? { id: 'open', name: '作業中', is_done: false }
        : { id: 'done', name: null, is_done: true },
  }));
  await page.getByRole('link', { name: '印を変えない', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '印を変えない' });
  await expect(drawer.getByRole('definition').filter({ hasText: /^なし$/ })).toBeVisible();
  await drawer.getByRole('button', { name: '完了にする', exact: true }).click();
  const sun = drawer.getByRole('button', { name: '今日やる: 印を変えない', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'true');
  await expect(sun).toHaveAccessibleDescription('完了したタスクの今日やるの印は付け外しできません');
  await expect(drawer.locator('.status-dot')).toHaveText('完了');
});

test('終了したワークスペースは今日やるを無効にし、理由を読める', async ({ page }) => {
  await createWorkspace(page, '引き出しの終了');
  await addTaskRow(page, '終了後に読む');
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.reload();
  await page.getByRole('link', { name: '終了後に読む', exact: true }).click();
  const sun = page
    .getByRole('dialog', { name: '終了後に読む' })
    .getByRole('button', { name: '今日やる: 終了後に読む', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'true');
  await expect(sun).toHaveAccessibleDescription('終了したワークスペースには書き込めません');
});

test('今日やるの変更時にタスクが削除済みなら引き出しを閉じる', async ({ page }) => {
  await createWorkspace(page, '引き出しの削除競合');
  await addTaskRow(page, '先に消えた');
  await page.getByRole('link', { name: '先に消えた', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '先に消えた' });
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: 'ミナト' });
  const sun = drawer.getByRole('button', { name: '今日やる: 先に消えた', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await failOperation(page, taskTodayMark, { slug: 'aoba' }, 404, 'not_found');
  await failOperation(page, taskDetail, { slug: 'aoba' }, 404, 'not_found');
  await sun.click();
  await expect(drawer).toHaveCount(0);
});

test('今日やるの遅い応答で担当変更後の印を戻さない', async ({ page }) => {
  await createWorkspace(page, '引き出しの遅い印');
  await addTaskRow(page, '担当と印の競合');
  await page.getByRole('link', { name: '担当と印の競合', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '担当と印の競合' });
  const assignee = drawer.getByRole('combobox', { name: '担当', exact: true });
  await assignee.selectOption({ label: 'ミナト' });
  const sun = drawer.getByRole('button', { name: '今日やる: 担当と印の競合', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  let applied = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, async (call) => {
    const output = await call.fetch();
    applied = true;
    await released;
    await call.fulfill(output);
  });
  try {
    await sun.click();
    await expect.poll(() => applied).toBe(true);
    await assignee.selectOption({ label: '担当なし' });
    await expect(drawer.getByText('自分が担当するタスクだけ今日やるの印を付け外しできます')).toBeVisible();
  } finally {
    release();
  }
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  await assignee.selectOption({ label: 'ミナト' });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  await waitForSettled(page);
});

for (const width of [390, 1280]) {
  test(`長い列名が引き出しからはみ出さない（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await createWorkspace(page, '引き出しの長い列');
    await addTaskRow(page, '長い列を読む');
    await rewriteOperation(page, taskDetail, { slug: 'aoba' }, (output) => ({
      ...output,
      column: { id: 'long', name: '長い列の名前'.repeat(5), is_done: false },
    }));
    await page.getByRole('link', { name: '長い列を読む', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '長い列を読む' });
    await expect(drawer.locator('.status-dot')).toHaveText('長い列の名前'.repeat(5));
    await expect
      .poll(() => drawer.locator('.props').evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  });
}

test('古い詳細の応答で担当変更後の印を戻さない', async ({ page }) => {
  await createWorkspace(page, '引き出しの遅い詳細');
  await addTaskRow(page, '詳細の読み取り競合');
  await page.getByRole('link', { name: '詳細の読み取り競合', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '詳細の読み取り競合' });
  const assignee = drawer.getByRole('combobox', { name: '担当', exact: true });
  await assignee.selectOption({ label: 'ミナト' });
  const sun = drawer.getByRole('button', { name: '今日やる: 詳細の読み取り競合', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  let captured = false;
  let delayNext = true;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, taskDetail, { slug: 'aoba' }, async (call) => {
    const delay = delayNext;
    delayNext = false;
    const output = await call.fetch();
    if (delay) {
      captured = true;
      await released;
    }
    await call.fulfill(output);
  });
  try {
    await sun.click();
    await expect.poll(() => captured).toBe(true);
    await assignee.selectOption({ label: '担当なし' });
    await expect(drawer.getByText('自分が担当するタスクだけ今日やるの印を付け外しできます')).toBeVisible();
  } finally {
    release();
  }
  await waitForSettled(page);
  await expect(assignee).toHaveValue('');
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  await assignee.selectOption({ label: 'ミナト' });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  await waitForSettled(page);
});
