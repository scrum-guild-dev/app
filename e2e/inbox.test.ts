// 受信箱の画面（#926）。seed の受託開発チームの受信箱（読むだけ）と、接続の無い社内ツール（読むだけ）、
// 作ったワークスペースに入れたタスクをバックログへ入れる流れ。入れる操作は戻らないので、seed のタスクには行わない
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, waitForResponses, watchViolations } from './helpers.ts';
import { seedInboxTasks } from './local-d1.ts';

const ADMIN_USER_ID = '019a0000-0000-7000-8000-000000000301';
const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const HIBARI_TOOLS = '/hibari/w/019a0000-0000-7000-8000-000000000402';

test.use({ timezoneId: 'Asia/Tokyo' });
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('受信箱に、取り込み元のキーと届いた日時と最後に成功した同期が並び、バックログには出ない', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.goto(`${WORKSPACE}/inbox`);
  await expect(page.getByRole('heading', { level: 1, name: '受信箱' })).toBeVisible();
  const list = page.getByRole('list', { name: '受信箱のタスク' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  const row = list.getByRole('listitem').filter({ hasText: '決済の確認画面で金額が欠ける' });
  await expect(row.getByRole('link', { name: 'aoba/point-api#41' })).toHaveAttribute(
    'href',
    'https://github.com/aoba/point-api/issues/41',
  );
  await expect(row).toContainText('届いた 2026-10-19 18:00');
  await expect(row).toContainText('ミナトの GitHub');
  await expect(page.locator('.callout')).toContainText('最後に成功した同期は 2026-10-20 10:30');
  // 受信箱のタスクは、入れるまでバックログに出ない
  await page.goto(WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(page.getByText('決済の確認画面で金額が欠ける')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('接続が無いワークスペースでは、接続の登録へ誘う空の表示が出る', async ({ page }) => {
  await page.goto(`${HIBARI_TOOLS}/inbox`);
  await expect(page.getByRole('heading', { level: 1, name: '受信箱' })).toBeVisible();
  await expect(page.getByText('接続がまだありません')).toBeVisible();
  // 見本と同じく、アイコンの代わりに線画（notice）を置く
  await expect(page.locator('.empty', { hasText: '接続がまだありません' }).locator('svg.art')).toHaveCount(1);
  await expect(page.getByRole('list', { name: '受信箱のタスク' })).toHaveCount(0);
});

test('受信箱から、1件とまとめて選んだタスクをバックログの末尾へ入れる', async ({ page }) => {
  const suffix = `${test.info().repeatEachIndex}-${test.info().retry}`;
  await createWorkspace(page, `受信箱-${suffix}`);
  const workspaceId = /\/w\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (workspaceId === undefined) throw new Error('ワークスペースの ID を URL から取れなかった');
  const titles = [`一件目-${suffix}`, `二件目-${suffix}`, `三件目-${suffix}`];
  await seedInboxTasks(workspaceId, ADMIN_USER_ID, titles);

  await page.goto(`/aoba/w/${workspaceId}/inbox`);
  const list = page.getByRole('list', { name: '受信箱のタスク' });
  await expect(list.getByRole('listitem')).toHaveCount(3);

  // 行の「バックログへ」で1件
  const first = waitForResponses(page, '/inbox-to-backlog');
  await page.getByRole('button', { name: `「${titles[0]}」をバックログへ入れる` }).click();
  await first;
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(page.locator('.toasts:visible .toast').last()).toHaveText(`「${titles[0]}」をバックログへ入れました`);

  // 選んだものをまとめて
  await page.getByRole('checkbox', { name: `「${titles[1]}」を選ぶ` }).check();
  await page.getByRole('checkbox', { name: `「${titles[2]}」を選ぶ` }).check();
  await expect(page.getByText('2 件を選んでいます')).toBeVisible();
  const rest = waitForResponses(page, '/inbox-to-backlog');
  await page.getByRole('button', { name: '選んだものをバックログへ' }).click();
  await rest;
  await expect(page.getByText('届いたものはありません')).toBeVisible();

  // バックログの末尾に、届いた順に出る
  await page.goto(`/aoba/w/${workspaceId}`);
  const rows = page.locator('.entry-title');
  await expect(rows.filter({ hasText: titles[0]! })).toBeVisible();
  const texts = await rows.allTextContents();
  const order = titles.map((title) => texts.findIndex((text) => text.includes(title)));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});
