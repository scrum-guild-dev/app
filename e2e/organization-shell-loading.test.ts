import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { routeOperation, mockOperation, failOperation } from './operations.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { invitationList } from '../src/shared/operations/workspace/index.ts';
import { tokenNotice } from '../src/shared/operations/session/token-notice.ts';

const invitation = {
  invitation_id: '019a0000-0000-7000-8000-00000000fa01',
  workspace_id: '019a0000-0000-7000-8000-000000000404',
  workspace_name: 'デザイン相談室',
  closed: false,
  role: 'member' as const,
  invited_by_name: 'ユイ',
  invited_on: '2026-10-19',
};
const inbox = { organization: { name: 'あおば開発' }, invitations: [invitation] };
const noticeLabel = 'API トークンの発行の知らせ';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function invited(page: import('@playwright/test').Page) {
  await routeOperation(page, myOrganizations, async (call) => {
    const data = await call.fetch();
    await call.fulfill({ ...data, invitations: [{ organization_name: 'あおば開発', slug: 'aoba' }] });
  });
}

for (const width of [390, 1280]) {
  test(`${width}pxで通知と招待件数を待たず主を操作でき、通知より先に件数を出せる`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    await page.setViewportSize({ width, height: 900 });
    await invited(page);
    const count = gate();
    const notice = gate();
    await routeOperation(page, invitationList, { slug: 'aoba' }, async (call) => {
      await count.promise;
      await call.fulfill(inbox);
    });
    await routeOperation(page, tokenNotice, async (call) => {
      await notice.promise;
      await call.fulfill({ count: 0, latest: null });
    });
    try {
      await page.goto('/aoba');
      await expect(page.locator('#content')).toBeVisible();
      await expect(
        page.getByText(`${noticeLabel}: 読み込んでいます`, { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: /アカウントのメニュー/ }).click();
      const profile = page.getByRole('link', { name: 'マイプロフィール', exact: true });
      await expect(profile).toBeVisible();
      await expect(page.getByText('招待の件数を読み込んでいます', { exact: true })).toBeVisible();
      count.release();
      await expect(page.getByRole('link', { name: /マイプロフィール.*招待/ })).toContainText('1');
      // 件数の到着で開いたメニューを閉じず、本文にも触れない。
      await expect(page.locator('#content')).toBeVisible();
      notice.release();
      await expect(page.getByText(`${noticeLabel}: 読み込んでいます`, { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    } finally {
      count.release();
      notice.release();
    }
  });
}

test('従が失敗しても主を残し、招待件数と通知を別々に再試行する', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await invited(page);
  let counts = 0;
  let notices = 0;
  let primary = 0;
  await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
    primary++;
    await call.passThrough();
  });
  await routeOperation(page, invitationList, { slug: 'aoba' }, async (call) => {
    counts++;
    if (counts === 1) await call.fail(500, 'internal');
    else await call.fulfill(inbox);
  });
  await routeOperation(page, tokenNotice, async (call) => {
    notices++;
    if (notices === 1) await call.fail(500, 'internal');
    else await call.fulfill({ count: 0, latest: null });
  });
  await page.goto('/aoba');
  await expect(page.locator('#content')).toBeVisible();
  await page.getByRole('button', { name: /アカウントのメニュー/ }).click();
  await expect(page.locator('.account-menu-list:visible').getByRole('alert')).toHaveText(
    '招待の件数を読み込めませんでした。',
  );
  const retry = page.locator('.account-menu-list:visible').getByRole('button', { name: 'もう一度試す', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /マイプロフィール.*招待/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /マイプロフィール.*招待/ })).toBeFocused();
  expect(notices).toBe(1);
  await page.keyboard.press('Escape');
  await page
    .getByRole('region', { name: noticeLabel })
    .filter({ visible: true })
    .getByRole('button', { name: 'もう一度試す', exact: true })
    .click();
  await expect(page.getByRole('region', { name: noticeLabel })).toHaveCount(0);
  expect(counts).toBe(2);
  expect(primary).toBe(1);
});

test('招待が無い人は件数の要求を足さず、主の404は従が遅くても表示する', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let counts = 0;
  await routeOperation(page, myOrganizations, async (call) => {
    const data = await call.fetch();
    await call.fulfill({ ...data, invitations: [] });
  });
  await routeOperation(page, invitationList, { slug: 'aoba' }, async (call) => {
    counts++;
    await call.fulfill(inbox);
  });
  await mockOperation(page, tokenNotice, { count: 0, latest: null });
  await page.goto('/aoba');
  await expect(page.locator('#content')).toBeVisible();
  expect(counts).toBe(0);
  await failOperation(page, organizationInfo, { slug: 'aoba' }, 404, 'not_found');
  const notice = gate();
  await routeOperation(page, tokenNotice, async (call) => {
    await notice.promise;
    await call.fulfill({ count: 0, latest: null });
  });
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: '組織が見つかりません' })).toBeVisible();
    await expect(page.locator('.account-menu')).toHaveCount(0);
  } finally {
    notice.release();
  }
});

test('枠を離れて戻った後に古い通知・件数が届いても新しい結果を上書きしない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await invited(page);
  const old = gate();
  let counts = 0;
  let notices = 0;
  await routeOperation(page, invitationList, { slug: 'aoba' }, async (call) => {
    const first = ++counts === 1;
    if (first) await old.promise;
    await call.fulfill(first ? inbox : { ...inbox, invitations: [] });
  });
  await routeOperation(page, tokenNotice, async (call) => {
    const first = ++notices === 1;
    if (first) await old.promise;
    await call.fulfill(
      first
        ? {
            count: 1,
            latest: { name: '古い通知', scope: 'read', created_at: '2026-11-04T01:30:00.000Z', revoked: false },
          }
        : { count: 0, latest: null },
    );
  });
  async function follow(href: string) {
    await page.evaluate((href) => {
      document.querySelector('[data-shell-test-link]')?.remove();
      const link = document.createElement('a');
      link.href = href;
      link.textContent = '組織枠のテスト用の移動';
      link.dataset.shellTestLink = '';
      document.body.append(link);
    }, href);
    await page.locator('[data-shell-test-link]').click();
    await expect(page).toHaveURL((url) => url.pathname === href);
  }
  try {
    await page.goto('/aoba');
    await expect(page.locator('#content')).toBeVisible();
    await expect.poll(() => counts).toBe(1);
    await expect.poll(() => notices).toBe(1);
    await follow('/login');
    await follow('/aoba');
    await expect.poll(() => counts).toBe(2);
    await page.getByRole('button', { name: /アカウントのメニュー/ }).click();
    await expect(page.getByText('招待の件数を読み込んでいます', { exact: true })).toHaveCount(0);
    const oldResponses = Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/aoba/invitation-list') && response.ok()),
      page.waitForResponse((response) => response.url().endsWith('/api/token-notice') && response.ok()),
    ]);
    old.release();
    await oldResponses;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect.poll(() => notices).toBe(2);
    await expect(page.getByRole('region', { name: noticeLabel })).toHaveCount(0);
    await expect(page.locator('.account-menu-badge')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'マイプロフィール', exact: true })).toBeVisible();
  } finally {
    old.release();
  }
});

test('初回通知を待つ間の同組織内移動でも再取得し、後着の初回通知を適用しない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const old = gate();
  let calls = 0;
  await routeOperation(page, tokenNotice, async (call) => {
    const first = ++calls === 1;
    if (first) await old.promise;
    await call.fulfill({
      count: 1,
      latest: {
        name: first ? '移動前の通知' : '移動後の通知',
        scope: 'read',
        created_at: first ? '2026-11-04T01:30:00.000Z' : '2026-11-05T01:30:00.000Z',
        revoked: false,
      },
    });
  });
  try {
    await page.goto('/aoba');
    await expect(page.locator('#content')).toBeVisible();
    await expect.poll(() => calls).toBe(1);
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/aoba/wiki';
      link.textContent = '通知の保留中に移動';
      link.dataset.pendingNoticeLink = '';
      document.body.append(link);
    });
    await page.locator('[data-pending-notice-link]').click();
    await expect(page).toHaveURL(/\/aoba\/wiki$/);
    await expect(page.getByRole('region', { name: noticeLabel }).filter({ visible: true })).toContainText(
      '移動後の通知',
    );
    const response = page.waitForResponse((response) => response.url().endsWith('/api/token-notice') && response.ok());
    old.release();
    await response;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(page.getByRole('region', { name: noticeLabel }).filter({ visible: true })).toContainText(
      '移動後の通知',
    );
    await expect(page.getByText('移動前の通知')).toHaveCount(0);
  } finally {
    old.release();
  }
});
