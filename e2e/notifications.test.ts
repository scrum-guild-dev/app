// #740 の画面内通知。応答を差し替えて表示と失敗時の操作を確かめ、実 API の保存・分離は Workers のテストで確かめる。
import { notificationList, notificationRead } from '../src/shared/operations/notification.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';

const warning = {
  id: '019a0000-0000-7000-8000-000000007401',
  kind: 'attachment_quota_warning',
  payload: { used_bytes: 81, quota_bytes: 100 },
  read_at: null,
  created_at: '2026-11-10T00:00:00.000Z',
} satisfies OutputOf<typeof notificationList>['notifications'][number];

test('通知の容量警告から管理へ移れ、既読にすると未読だけの一覧から外れる', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(context, baseURL, 'admin');
  let read = false;
  await routeOperation(page, notificationList, { slug: 'aoba' }, async (call) => {
    const rows = call.input.unread_only && read ? [] : [{ ...warning, read_at: read ? warning.created_at : null }];
    await call.fulfill({ notifications: rows, next: null, unread_count: read ? 0 : 1 });
  });
  await routeOperation(page, notificationRead, { slug: 'aoba' }, async (call) => {
    expect(call.input.id).toBe(warning.id);
    read = true;
    await call.fulfill({ id: warning.id, read_at: warning.created_at });
  });
  await page.goto('/aoba/notifications');
  await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeVisible();
  await expect(page.locator('.feed')).toContainText('上限の80%を超えました');
  await expect(page.getByRole('link', { name: '組織の管理を開く' })).toHaveAttribute('href', '/aoba/admin');
  for (const control of [
    page.getByRole('link', { name: '組織の管理を開く' }),
    page.getByRole('button', { name: '既読にする', exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('radio', { name: '未読だけ' }).check();
  await page.getByRole('button', { name: '既読にする', exact: true }).click();
  await expect(page.getByText('未読の通知はありません', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '通知', level: 1 })).toBeFocused();
  await page.getByRole('radio', { name: 'すべて', exact: true }).check();
  await expect(page.locator('.feed')).toContainText('上限の80%を超えました');
  await expect(page.getByRole('button', { name: '既読にする', exact: true })).toHaveCount(0);
});

test('既読を保存している間に別の操作へフォーカスを移したら、保存の成功で奪い返さない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  let finishRead!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  await routeOperation(page, notificationList, { slug: 'aoba' }, (call) =>
    call.fulfill({ notifications: [warning], next: null, unread_count: 1 }),
  );
  await routeOperation(page, notificationRead, { slug: 'aoba' }, async (call) => {
    await pending;
    await call.fulfill({ id: warning.id, read_at: warning.created_at });
  });
  await page.goto('/aoba/notifications');
  await page.getByRole('button', { name: '既読にする', exact: true }).click();
  const filter = page.getByRole('radio', { name: 'すべて', exact: true });
  await filter.focus();
  finishRead();
  await expect(page.getByRole('button', { name: '既読にする', exact: true })).toHaveCount(0);
  await expect(filter).toBeFocused();
});

test('通知の読み込み失敗は再試行でき、既読の失敗では通知を残す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  let fail = true;
  await routeOperation(page, notificationList, { slug: 'aoba' }, (call) =>
    fail ? call.fail(500, 'internal') : call.fulfill({ notifications: [warning], next: null, unread_count: 1 }),
  );
  await routeOperation(page, notificationRead, { slug: 'aoba' }, (call) => call.fail(500, 'internal'));
  await page.goto('/aoba/notifications');
  await expect(page.getByRole('alert')).toContainText('通知を読み込めませんでした');
  fail = false;
  await page.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(page.locator('.feed li')).toHaveCount(1);
  await expect(page.getByRole('link', { name: '組織の管理を開く' })).toHaveCount(0);
  await page.getByRole('button', { name: '既読にする', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('既読にできませんでした');
  await expect(page.locator('.feed li.is-unread')).toHaveCount(1);
});

test('通知の続きを読み、最後の通知まで読めたら終わりの案内にフォーカスする', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const older = { ...warning, id: '019a0000-0000-7000-8000-000000007402', created_at: '2026-11-09T00:00:00.000Z' };
  await routeOperation(page, notificationList, { slug: 'aoba' }, (call) =>
    call.fulfill({
      notifications: call.input.before ? [older] : [warning],
      next: call.input.before ? null : { id: warning.id, created_at: warning.created_at },
      unread_count: 2,
    }),
  );
  await page.goto('/aoba/notifications');
  await page.getByRole('button', { name: '続きを読む', exact: true }).click();
  await expect(page.locator('.feed li')).toHaveCount(2);
  await expect(page.getByText('通知をすべて表示しました', { exact: true })).toBeFocused();
});
