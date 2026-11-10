import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, signIn, waitForResponses, waitForSettled } from './helpers.ts';
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
  const refreshed = page.waitForResponse(
    async (response) =>
      response.url().endsWith('/task-detail') && response.ok() && (await response.json()).task.points === 5,
  );
  void refreshed.catch(() => {});
  try {
    await assignee.selectOption({ label: '担当なし' });
    await expect.poll(() => captured).toBe(true);
    const saved = waitForResponses(page, '/task-update');
    const history = waitForResponses(page, '/task-history');
    await points.check();
    await expect(
      page
        .locator('.entry', { hasText: '別の欄も保存する' })
        .getByRole('button', { name: 'ポイント: 5 pt', exact: true }),
    ).toBeVisible();
    await (await saved).finished();
    // 行の楽観表示ではなく、保存結果を表示した後で古い詳細を返す。
    await history;
  } finally {
    release();
  }
  await (await refreshed).finished();
  await waitForSettled(page);
  await expect(points).toBeChecked();
});

test('本文の保存が完了後の読み直しと重なっても、完了の表示と戻す操作を保つ', async ({ page }) => {
  await createWorkspace(page, '本文と完了の競合');
  await addTaskRow(page, '完了と本文を両方保存');
  await page.getByRole('link', { name: '完了と本文を両方保存', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '完了と本文を両方保存' });
  await expect(drawer.getByRole('button', { name: '本文を書く', exact: true })).toBeVisible();
  let updateCaptured = false;
  let detailCaptured = false;
  let releaseUpdate!: () => void;
  let releaseDetail!: () => void;
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  await routeOperation(page, taskUpdate, { slug: 'aoba' }, async (call) => {
    const output = await call.fetch();
    updateCaptured = true;
    await updateGate;
    await call.fulfill(output);
  });
  let first = true;
  await routeOperation(page, taskDetail, { slug: 'aoba' }, async (call) => {
    const delay = first;
    first = false;
    const output = await call.fetch();
    if (delay) {
      detailCaptured = true;
      await detailGate;
    }
    await call.fulfill(output);
  });
  try {
    await drawer.getByRole('button', { name: '本文を書く', exact: true }).click();
    const body = drawer.getByRole('textbox', { name: '本文', exact: true });
    await body.fill('保存した本文を保つ');
    await body.blur();
    await expect.poll(() => updateCaptured).toBe(true);
    await drawer.getByRole('button', { name: '完了にする', exact: true }).click();
    await expect.poll(() => detailCaptured).toBe(true);
    releaseUpdate();
    await expect(drawer.getByText('保存した本文を保つ', { exact: true })).toBeVisible();
  } finally {
    releaseUpdate();
    releaseDetail();
  }
  const reopen = drawer.getByRole('button', { name: '完了を戻す: 完了と本文を両方保存', exact: true });
  await expect(reopen).toBeVisible();
  await expect(drawer.getByRole('radio', { name: '5', exact: true })).toBeDisabled();
  const reopened = waitForResponses(page, '/task-detail');
  await reopen.click();
  await (await reopened).finished();
  await expect(drawer.getByRole('button', { name: '完了にする', exact: true })).toBeVisible();
  await expect(drawer.getByText('保存した本文を保つ', { exact: true })).toBeVisible();
  await waitForSettled(page);
});

test('印の読み直しを完了の読み直しが追い越しても、404 なら引き出しを閉じる', async ({ page }) => {
  await createWorkspace(page, '削除の読み直しが重なる');
  await addTaskRow(page, '消えた詳細を閉じる');
  await page.getByRole('link', { name: '消えた詳細を閉じる', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '消えた詳細を閉じる' });
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: 'ミナト' });
  const sun = drawer.getByRole('button', { name: '今日やる: 消えた詳細を閉じる', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, taskDetail, { slug: 'aoba' }, async (call) => {
    const read = ++reads;
    if (read === 1) await gate;
    await call.fail(404, 'not_found');
  });
  try {
    await sun.click();
    await expect.poll(() => reads).toBe(1);
    await drawer.getByRole('button', { name: '完了にする', exact: true }).click();
    await expect.poll(() => reads).toBe(2);
  } finally {
    release();
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.locator('.toast:visible').filter({ hasText: 'このタスクは見つかりません。一覧を読み直します' }),
  ).toHaveCount(1);
});

test('印の読み直し中に閉じても、成功した読み取りを失敗と知らせない', async ({ page }) => {
  await createWorkspace(page, '閉じた後の読み直し');
  await addTaskRow(page, '印を保存して閉じる');
  await page.getByRole('link', { name: '印を保存して閉じる', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '印を保存して閉じる' });
  await drawer.getByRole('combobox', { name: '担当', exact: true }).selectOption({ label: 'ミナト' });
  const sun = drawer.getByRole('button', { name: '今日やる: 印を保存して閉じる', exact: true });
  await expect(sun).toHaveAttribute('aria-disabled', 'false');
  let captured = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, taskDetail, { slug: 'aoba' }, async (call) => {
    const output = await call.fetch();
    if (output.today_on !== null) {
      captured = true;
      await gate;
    }
    await call.fulfill(output);
  });
  try {
    await sun.click();
    await expect.poll(() => captured).toBe(true);
    await drawer.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    release();
  }
  // 印操作の onchanged が呼ばれた後の木まで待ち、終了後の通知も確かめる。
  const reloaded = waitForResponses(page, '/backlog-tree');
  await (await reloaded).finished();
  await waitForSettled(page);
  // 消えるまで待って成功させない。更新完了直後に誤った通知が無いことを確かめる。
  expect(await page.locator('.toast:visible').filter({ hasText: '印は保存しましたが' }).count()).toBe(0);
});
