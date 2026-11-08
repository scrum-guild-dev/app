// 読み取りの応答が返らないとき、画面が読み込み中のまま止まらず、10 秒で読み込めなかった表示に替わる（#1039）。
// 組織の枠の中でスプリントの画面へ移り、sprint-board の応答を止めて時計を進める。止めた応答は最後に通信の失敗で片付ける。
// seed のセッション（seed/sessions.ts）の Cookie で開く。一般のユーザーはハルカ（あおば開発の受託開発チーム）
import { READ_TIMEOUT_MS } from '../src/lib/api.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test('移った先の読み取りが 10 秒返らなければ、読み込めなかった表示と「もう一度試す」が出て、押すと読み直す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.clock.install();
  await page.goto(WORKSPACE);
  await expect(page.getByRole('link', { name: 'スプリント', exact: true })).toBeVisible();

  // 最初の呼び出しだけ、片付けるまで返さない。2 回目からは本物の API へ流す
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await routeOperation(page, sprintBoard, { slug: 'aoba' }, async (call) => {
    calls += 1;
    if (calls > 1) return call.passThrough();
    await released;
    // 画面はもう打ち切っているので、応答の行き先は無い。通信の失敗で片付ける
    await call.abort().catch(() => {});
  });

  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  await expect.poll(() => calls).toBe(1);

  // 上限の半ばでは、まだ失敗を出さない（時計は実時間でも進むので、上限の直前では見ない。下限は src/lib/api.test.ts が確かめる）
  await page.clock.runFor(READ_TIMEOUT_MS / 2);
  const failed = page.getByRole('heading', { level: 1, name: '読み込めませんでした' });
  await expect(failed).toHaveCount(0);

  await page.clock.runFor(READ_TIMEOUT_MS / 2 + 500);
  await expect(failed).toBeVisible();
  await expect(page).toHaveURL(`${WORKSPACE}/sprint`);
  // 組織の枠（左のメニュー）は残る
  await expect(page.getByRole('link', { name: 'スプリント', exact: true })).toBeVisible();

  // もう一度試すと、本物の API へ流した 2 回目の読み取りで、スプリントの画面が出る
  await page.getByRole('button', { name: 'もう一度試す' }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント' })).toBeVisible();
  await expect(failed).toHaveCount(0);
  release();
});

test('組織の選択から移って組織の読み取りが 10 秒返らなければ、読み込み中の紙のまま止まらず、読み込めなかった表示に替わる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  // 招待を足して、組織が1つでも組織の選択に留める（入れる組織が1つで招待が無いと、そのまま組織へ移る）
  await routeOperation(page, myOrganizations, (call) =>
    call.fulfill({
      organizations: [{ slug: 'aoba', name: 'あおば開発', kind: 'team' }],
      invitations: [{ organization_name: 'つばめ商会', slug: 'tsubame' }],
      suspended: [],
      operator: false,
    }),
  );
  await page.clock.install();
  await page.goto('/');

  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
    calls += 1;
    await released;
    await call.abort().catch(() => {});
  });

  await page.getByRole('link', { name: /あおば開発/ }).click();
  await expect.poll(() => calls).toBe(1);
  await page.clock.runFor(1_000);
  await expect(page.getByRole('heading', { level: 1, name: '読み込んでいます' })).toBeVisible();

  await page.clock.runFor(READ_TIMEOUT_MS);
  await expect(page.getByRole('heading', { level: 1, name: '読み込めませんでした' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '読み込んでいます' })).toHaveCount(0);
  // 読み上げの領域も「読み込んでいます」のまま残らない
  await expect(page.locator('[role="status"].visually-hidden').first()).not.toHaveText('読み込んでいます');
  release();
});
