import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn, waitForSettled } from './helpers.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';
import { categoryRepositoryList } from '../src/shared/operations/definition/index.ts';
import { taskDetail, taskUpdate } from '../src/shared/operations/task/index.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('後発の詳細を待った保存でも、存在するタスクを消えたと判断しない', async ({ page }) => {
  await createWorkspace(page, '再読み込みが重なる');
  await addTaskRow(page, '消えていないタスク');
  await rewriteOperation(page, categoryRepositoryList, { slug: 'aoba' }, (output) => ({
    ...output,
    repositories: [{ id: '019a0000-0000-7000-8000-000000000999', name: '削除された接続' }],
  }));
  await page.getByRole('link', { name: '消えていないタスク', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '消えていないタスク' });
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: 'ミナト' });
  const sun = drawer.getByRole('button', { name: '今日やる: 消えていないタスク', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  let captured = false;
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, taskDetail, { slug: 'aoba' }, async (call) => {
    const delay = first;
    first = false;
    const output = await call.fetch();
    if (delay) {
      captured = true;
      await gate;
    }
    await call.fulfill(output);
  });
  await failOperation(page, taskUpdate, { slug: 'aoba' }, 404, 'not_found');
  try {
    await drawer.getByRole('radio', { name: '削除された接続', exact: true }).check();
    await expect.poll(() => captured).toBe(true);
    await sun.click();
    await expect(sun).toHaveAttribute('aria-pressed', 'true');
    await expect(sun).toHaveAttribute('aria-disabled', 'false');
  } finally {
    release();
  }
  await waitForSettled(page);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('選んだリポジトリは削除されています。選び直してください')).toBeVisible();
});

test('印の保存後に詳細が読めなくても押された状態を保ち、次のクリックで外す', async ({ page }) => {
  await createWorkspace(page, '印の保存と読み直し');
  await addTaskRow(page, '保存済みの印');
  await page.getByRole('link', { name: '保存済みの印', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '保存済みの印' });
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: 'ミナト' });
  const sun = drawer.getByRole('button', { name: '今日やる: 保存済みの印', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  const unroute = await failOperation(page, taskDetail, { slug: 'aoba' }, 500, 'internal');
  await sun.click();
  await waitForSettled(page);
  await expect(sun).toHaveAttribute('aria-pressed', 'true');
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  await unroute();
  await sun.click();
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  await waitForSettled(page);
});

test('担当変更後の遅い読み直しがポイントの保存を戻さない', async ({ page }) => {
  await createWorkspace(page, '担当とポイントの保存');
  await addTaskRow(page, '別の欄も保存する');
  await page.getByRole('link', { name: '別の欄も保存する', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '別の欄も保存する' });
  const assignee = drawer.getByRole('combobox', { name: '担当', exact: true });
  await assignee.selectOption({ label: 'ミナト' });
  await expect(drawer.getByRole('button', { name: '今日やる: 別の欄も保存する', exact: true })).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  let captured = false;
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, taskDetail, { slug: 'aoba' }, async (call) => {
    const delay = first;
    first = false;
    const output = await call.fetch();
    if (delay) {
      captured = true;
      await gate;
    }
    await call.fulfill(output);
  });
  const points = drawer.getByRole('radio', { name: '5', exact: true });
  try {
    await assignee.selectOption({ label: '担当なし' });
    await expect.poll(() => captured).toBe(true);
    await points.check();
    await expect(
      page
        .locator('.entry', { hasText: '別の欄も保存する' })
        .getByRole('button', { name: 'ポイント: 5 pt', exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
  await waitForSettled(page);
  await expect(points).toBeChecked();
});
