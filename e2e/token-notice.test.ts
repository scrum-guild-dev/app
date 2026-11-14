import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled, watchViolations } from './helpers.ts';
import { tokenNotice, tokenNoticeSeen } from '../src/shared/operations/session/token-notice.ts';
import { invitationList } from '../src/shared/operations/workspace/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

const label = 'API トークンの発行の知らせ';

// 画面に無い query の変化と招待への移動も、SvelteKit が捕まえる通常のリンクで行う。
async function follow(page: Page, path: string): Promise<void> {
  await page.evaluate((href) => {
    document.querySelector('[data-notice-test-link]')?.remove();
    const link = document.createElement('a');
    link.href = href;
    link.textContent = '通知のテスト用の画面移動';
    link.dataset.noticeTestLink = '';
    document.body.append(link);
  }, path);
  await page.locator('[data-notice-test-link]').click();
  await expect(page).toHaveURL((url) => url.pathname + url.search === path);
}

test('別端末の発行を組織の画面に出し、取り消した発行も残し、「確かめた」を押すとこの端末で消える', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await signIn(context, baseURL, 'tokenNoticeIssuer');
  const viewer = await browser.newContext({ baseURL });
  try {
    await signIn(viewer, baseURL, 'tokenNoticeViewer');
    const other = await viewer.newPage();
    await page.goto('/kaze/me');
    await other.goto('/kaze/me');
    const name = `発行の知らせ ${Date.now().toString(36)}`;
    const section = page.getByRole('region', { name: 'API トークン', exact: true });
    await section.getByLabel('名前', { exact: true }).fill(name);
    await section.getByRole('button', { name: '発行する' }).click();
    const issued = page.getByRole('dialog', { name: 'API トークンを発行しました' });
    await expect(issued).toBeVisible();
    await issued.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
    await page.reload();
    await waitForSettled(page);
    await expect(page.getByRole('region', { name: label })).toHaveCount(0);

    // 発行後すぐ取り消しても、別端末には発行が残る。
    const row = section.getByRole('table').locator('tbody tr', { hasText: name });
    await row.getByRole('button', { name: `API トークン「${name}」を取り消す` }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取り消す', exact: true }).click();
    await expect(row).toHaveCount(0);
    await other.reload();
    const notice = other.getByRole('region', { name: label });
    await expect(notice).toContainText(name);
    await expect(notice).toContainText('取り消し済み');
    await expect(notice.getByRole('link', { name: '設定を開く' })).toHaveAttribute('href', '/kaze/me#api-tokens');
    await notice.getByRole('button', { name: '確かめた', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await other.reload();
    await waitForSettled(other);
    await expect(notice).toHaveCount(0);
  } finally {
    await viewer.close();
  }
});

const latest = {
  name: '長い名前の確かめ'.repeat(10),
  scope: 'write' as const,
  created_at: '2026-11-04T01:30:00.000Z',
  revoked: false,
};
for (const width of [320, 390, 1024, 1280]) {
  test(`${width}pxで長い名前を折り返し、帯と操作が横にはみ出さない`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, tokenNotice, { count: 2, latest });
    await page.setViewportSize({ width, height: 900 });
    const collect = await watchViolations(page);
    await page.goto('/aoba/me');
    const notice = page.getByRole('region', { name: label });
    await expect(notice).toContainText(latest.name);
    for (const role of ['button', 'link'] as const) {
      const box = await notice.getByRole(role).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(await collect()).toEqual([]);
  });
}

test('確認に失敗したら帯と再試行の操作を残す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, tokenNotice, { count: 2, latest });
  await failOperation(page, tokenNoticeSeen, 500, 'internal');
  await page.goto('/aoba/me');
  const notice = page.getByRole('region', { name: label });
  await notice.getByRole('button', { name: '確かめた', exact: true }).click();
  await expect(notice.getByRole('alert')).toHaveText(
    '確認を保存できませんでした。もう一度「確かめた」を押してください。',
  );
  await expect(notice).toContainText(latest.name);
});

test('表示した日時だけを確認に送り、その間に増えた発行を帯に残す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let confirmed = false;
  const newer = { ...latest, name: '後から増えた発行', created_at: '2026-11-04T01:31:00.000Z' };
  await routeOperation(page, tokenNotice, async (call) => {
    await call.fulfill({ count: 1, latest: confirmed ? newer : latest });
  });
  await routeOperation(page, tokenNoticeSeen, async (call) => {
    expect(call.input.created_at).toBe(latest.created_at);
    confirmed = true;
    await call.fulfill({});
  });
  await page.goto('/aoba/me');
  const notice = page.getByRole('region', { name: label });
  await expect(notice).toContainText(latest.name);
  await notice.getByRole('button', { name: '確かめた', exact: true }).click();
  await expect(notice).toContainText(newer.name);
  await expect(notice.getByRole('button', { name: '確かめた', exact: true })).toBeFocused();
});

for (const initialFailure of [false, true]) {
  test(`${initialFailure ? '読取失敗の再試行' : '確認'}は通知だけを読み直し、組織情報が一時的に失敗しても本文を残す`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    let orgCalls = 0;
    await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
      orgCalls++;
      if (orgCalls === 1) await call.passThrough();
      else await call.fail(500, 'internal');
    });
    let noticeCalls = 0;
    let confirmed = false;
    await routeOperation(page, tokenNotice, async (call) => {
      noticeCalls++;
      if (initialFailure && noticeCalls === 1) await call.fail(500, 'internal');
      else await call.fulfill(confirmed ? { count: 0, latest: null } : { count: 1, latest });
    });
    await routeOperation(page, tokenNoticeSeen, async (call) => {
      confirmed = true;
      await call.fulfill({});
    });
    await page.goto('/aoba/me');
    const heading = page.getByRole('heading', { level: 2, name: 'API トークン', exact: true });
    await expect(heading).toBeVisible();
    await expect(page.locator('main#content')).not.toHaveAttribute('tabindex');
    const notice = page.getByRole('region', { name: label });
    if (initialFailure) {
      await expect(notice).toContainText('API トークンの発行の知らせを読み込めませんでした。');
      await notice.getByRole('button', { name: 'もう一度試す', exact: true }).click();
      await expect(notice).toContainText(latest.name);
    } else {
      await notice.getByRole('button', { name: '確かめた', exact: true }).click();
      await expect(notice).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: 'API トークンの発行を確かめました' })).toBeVisible();
      const content = page.locator('main#content');
      await expect(content).toBeFocused();
      await expect(content).toHaveAttribute('tabindex', '-1');
      const field = page.getByRole('region', { name: 'API トークン', exact: true }).getByLabel('名前', { exact: true });
      await field.focus();
      await expect(field).toBeFocused();
      await expect(content).not.toHaveAttribute('tabindex');
    }
    await expect(heading).toBeVisible();
    expect(orgCalls).toBe(1);
    expect(noticeCalls).toBe(2);
  });
}

test('保存中を見える文言で出し、他へ移ったフォーカスを奪わない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let confirmed = false;
  let release!: () => void;
  const ready = new Promise<void>((done) => {
    release = done;
  });
  await routeOperation(page, tokenNotice, async (call) => {
    await call.fulfill(confirmed ? { count: 0, latest: null } : { count: 1, latest });
  });
  await routeOperation(page, tokenNoticeSeen, async (call) => {
    await ready;
    confirmed = true;
    await call.fulfill({});
  });
  await page.goto('/aoba/me');
  const notice = page.getByRole('region', { name: label });
  await notice.getByRole('button', { name: '確かめた', exact: true }).click();
  await expect(notice.getByRole('button', { name: '確認を保存しています', exact: true })).toBeVisible();
  const field = page.getByRole('region', { name: 'API トークン', exact: true }).getByLabel('名前', { exact: true });
  await field.focus();
  release();
  await expect(notice).toHaveCount(0);
  await expect(field).toBeFocused();
});

test('設定へのリンクを押すと API トークンの節に着く', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, tokenNotice, { count: 1, latest });
  await page.goto('/aoba');
  await page.getByRole('region', { name: label }).getByRole('link', { name: '設定を開く' }).click();
  await expect(page).toHaveURL(/\/aoba\/me#api-tokens$/);
  await expect(page.locator('#api-tokens')).toBeInViewport();
});

test('確認が成功して再取得だけ失敗したら、確認済みを復活させず更新失敗と再試行を出す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  let reads = 0;
  await routeOperation(page, tokenNotice, async (call) => {
    reads++;
    if (reads === 1) await call.fulfill({ count: 1, latest });
    else if (reads === 2) await call.fail(500, 'internal');
    else await call.fulfill({ count: 0, latest: null });
  });
  await mockOperation(page, tokenNoticeSeen, {});
  await page.goto('/aoba/me');
  const notice = page.getByRole('region', { name: label });
  await expect(notice).toContainText(latest.name);
  await notice.getByRole('button', { name: '確かめた', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'API トークンの発行を確かめました' })).toBeVisible();
  await expect(notice.getByRole('alert')).toHaveText(
    'API トークンの発行の知らせを更新できませんでした。もう一度試してください。',
  );
  await expect(notice).not.toContainText(latest.name);
  await expect(notice.getByRole('button', { name: '確かめた', exact: true })).toHaveCount(0);
  await notice.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(notice).toHaveCount(0);
});

test('経路移動の更新が失敗しても既知の発行と本文を残し、queryだけでは読み直さず再試行できる', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  let orgCalls = 0;
  await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
    orgCalls++;
    if (orgCalls === 1) await call.passThrough();
    else await call.fail(500, 'internal');
  });
  let reads = 0;
  const newer = { ...latest, name: '再試行で読めた発行', created_at: '2026-11-04T01:31:00.000Z' };
  await routeOperation(page, tokenNotice, async (call) => {
    reads++;
    if (reads === 2) await call.fail(500, 'internal');
    else await call.fulfill({ count: 1, latest: reads === 1 ? latest : newer });
  });
  await page.goto('/aoba');
  const notice = page.getByRole('region', { name: label });
  await expect(notice).toContainText(latest.name);
  await follow(page, '/aoba/me');
  await expect(notice.getByRole('alert')).toHaveText(
    'API トークンの発行の知らせを更新できませんでした。もう一度試してください。',
  );
  await expect(notice).toContainText('未確認の API トークンの発行が1件あります');
  await expect(notice).toContainText(latest.name);
  await expect(notice.locator('time')).toHaveAttribute('datetime', latest.created_at);
  await expect(page.getByRole('heading', { level: 1, name: 'マイプロフィール' })).toBeVisible();
  await follow(page, '/aoba/me?notice-check=1');
  await waitForSettled(page);
  expect(reads).toBe(2);
  expect(orgCalls).toBe(1);
  await notice.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(notice).toContainText(newer.name);
  await expect(notice.getByRole('alert')).toHaveCount(0);
});

test('同じ組織の SPA 経路移動で新しい発行を拾い、組織情報は読み直さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let orgCalls = 0;
  await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
    orgCalls++;
    if (orgCalls === 1) await call.passThrough();
    else await call.fail(500, 'internal');
  });
  let reads = 0;
  await routeOperation(page, tokenNotice, async (call) => {
    reads++;
    await call.fulfill(reads === 1 ? { count: 0, latest: null } : { count: 1, latest });
  });
  await page.goto('/aoba');
  await waitForSettled(page);
  const notice = page.getByRole('region', { name: label });
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
  await page.getByRole('link', { name: 'マイプロフィール', exact: true }).click();
  await expect(page).toHaveURL(/\/aoba\/me$/);
  await expect(notice).toContainText(latest.name);
  expect(reads).toBe(2);
  expect(orgCalls).toBe(1);
});

for (const newIssue of [false, true]) {
  test(`同じ組織の招待画面から戻ると、${newIssue ? '新しい発行を拾う' : '確認済みの発行は復活しない'}`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'admin');
    let reads = 0;
    let confirmed = false;
    let returned = false;
    const newer = { ...latest, name: '招待画面を見ている間の発行', created_at: '2026-11-04T01:32:00.000Z' };
    await routeOperation(page, tokenNotice, async (call) => {
      reads++;
      await call.fulfill(
        !confirmed
          ? { count: 1, latest }
          : returned && newIssue
            ? { count: 1, latest: newer }
            : { count: 0, latest: null },
      );
    });
    await routeOperation(page, tokenNoticeSeen, async (call) => {
      confirmed = true;
      await call.fulfill({});
    });
    await mockOperation(
      page,
      invitationList,
      { slug: 'aoba' },
      { organization: { name: 'あおば開発' }, invitations: [] },
    );
    await page.goto('/aoba/me');
    const notice = page.getByRole('region', { name: label });
    await expect(notice).toContainText(latest.name);
    await notice.getByRole('button', { name: '確かめた', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await follow(page, '/aoba/invitations');
    await expect(page.getByRole('link', { name: '組織の画面へ戻る', exact: true })).toBeVisible();
    returned = true;
    await page.getByRole('link', { name: '組織の画面へ戻る', exact: true }).click();
    await expect(page).toHaveURL(/\/aoba$/);
    await expect.poll(() => reads).toBe(3);
    await waitForSettled(page);
    if (newIssue) {
      await expect(notice).toContainText(newer.name);
      await expect(notice).not.toContainText(latest.name);
    } else await expect(notice).toHaveCount(0);
  });
}

test('後の経路で読んだ知らせを、遅れて返った前の経路の応答で巻き戻さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  let reads = 0;
  let release!: () => void;
  const ready = new Promise<void>((done) => {
    release = done;
  });
  const newer = { ...latest, name: '新しい経路で読んだ発行', created_at: '2026-11-04T01:33:00.000Z' };
  await routeOperation(page, tokenNotice, async (call) => {
    const number = ++reads;
    if (number === 2) await ready;
    await call.fulfill({ count: 1, latest: number < 3 ? latest : newer });
  });
  try {
    await page.goto('/aoba');
    const notice = page.getByRole('region', { name: label });
    await expect(notice).toContainText(latest.name);
    await follow(page, '/aoba/me');
    await expect.poll(() => reads).toBe(2);
    await follow(page, '/aoba');
    await expect(notice).toContainText(newer.name);
    release();
    await waitForSettled(page);
    await expect(notice).toContainText(newer.name);
  } finally {
    release();
  }
});
