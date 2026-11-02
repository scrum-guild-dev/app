// マイプロフィール（/<slug>/me）の「API トークン」の節の末尾の、危険な操作「すべての端末とトークンを締め出す」（#715）。
// 今の画面のセッション以外のすべてのセッションと、取り消していないすべてのトークンを無効にする（credentials-revoke-all）。
// 本物の実行は、くもラボのコハル（lookThemed）で行う。実行すると、そのアカウントのほかのセッションがすべて消えるので、
// admin など、並べて走るほかのテストが共有する seed のセッションがあるアカウントでは行わない（実行するのは seed のセッション、
// 消えるのは e2e/local-d1.ts の OTHER_DEVICE_SESSION だけ）。やめる、失敗は、応答を差し替えて共有のセッション（admin）で確かめる
import type { Page } from '@playwright/test';
import { credentialsRevokeAll } from '../src/shared/operations/session/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { expect, test } from './fixtures.ts';
import { signIn, waitForSettled, watchViolations } from './helpers.ts';
import { insertOtherDeviceSession, OTHER_DEVICE_SESSION } from './local-d1.ts';
import { failOperation, routeOperation } from './operations.ts';

const BUTTON = 'すべての端末とトークンを締め出す';
const DIALOG = 'すべての端末とトークンを締め出しますか';

const sectionOf = (page: Page) => page.getByRole('region', { name: 'API トークン', exact: true });
const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

async function issue(page: Page, name: string): Promise<string> {
  const section = sectionOf(page);
  await section.getByLabel('名前', { exact: true }).fill(name);
  await section.getByRole('button', { name: '発行する' }).click();
  const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
  await expect(dialog).toBeVisible();
  const token = await dialog.getByLabel('トークンの値').inputValue();
  await dialog.locator('.dialog-foot').getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toHaveCount(0);
  return token;
}

test('確認を経て実行すると、今の画面は使い続けられ、ほかの端末のセッションと、すべてのトークンが使えなくなり、件数を知らせて一覧が空になる', async ({
  page,
  context,
  browser,
  request,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const collect = await watchViolations(page);
  const cookieName = sessionCookieName(baseURL);
  const origin = new URL(baseURL).origin;
  const meWithCookie = async (token: string) =>
    (
      await request.post('/api/me', {
        headers: { Origin: origin, Cookie: `${cookieName}=${token}` },
        data: {},
      })
    ).status();
  const meWithBearer = async (token: string) =>
    (
      await request.post('/api/me', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {},
      })
    ).status();

  // ほかの端末のセッション（盗まれた Cookie の想定）。同じアカウントの、別の Cookie
  await insertOtherDeviceSession();
  expect(await meWithCookie(OTHER_DEVICE_SESSION.token)).toBe(200);

  await signIn(context, baseURL, 'lookThemed');
  await page.goto('/kumo/me');
  const section = sectionOf(page);
  await expect(
    section
      .getByRole('table', { name: '発行済みの API トークン' })
      .or(section.getByText('発行済みの API トークンはありません')),
  ).toBeVisible();
  await waitForSettled(page);

  // 取り消していないトークンを1つ作る（値は発行の直後に1回だけ見える）
  const bearer = await issue(page, `締め出しの確かめ ${Date.now().toString(36)}`);
  await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  expect(await meWithBearer(bearer)).toBe(200);

  // ほかの端末の画面。実行の前は開ける
  const otherContext = await browser.newContext();
  try {
    await otherContext.addCookies([
      { name: cookieName, value: OTHER_DEVICE_SESSION.token, url: baseURL, httpOnly: true },
    ]);
    const otherPage = await otherContext.newPage();
    await otherPage.goto('/kumo/me');
    await expect(otherPage.getByRole('heading', { level: 2, name: 'API トークン' })).toBeVisible();

    // 危険な操作の欄。小見出し、説明、ボタン。確認のダイアログでやめると、何も起きない
    await expect(section.getByRole('heading', { level: 3, name: BUTTON })).toBeVisible();
    const button = section.getByRole('button', { name: BUTTON });
    await button.click();
    const confirm = page.getByRole('dialog', { name: DIALOG });
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText(
        'この画面以外でログインしているすべての端末はログアウトされ、発行済みのすべての API トークンはすぐ使えなくなります。元に戻せません。',
        { exact: false },
      ),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'やめる' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(await meWithCookie(OTHER_DEVICE_SESSION.token)).toBe(200);
    expect(await meWithBearer(bearer)).toBe(200);

    // 実行。件数を知らせ、一覧は空になる。今の画面は移動せず、使い続けられる
    await button.click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '締め出す', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(toast(page, /ほかの端末のセッション1件と、API トークン[1-9]\d*件を締め出しました/)).toBeVisible();
    await expect(section.getByText('発行済みの API トークンはありません')).toBeVisible();
    await expect(section.getByRole('table')).toHaveCount(0);
    await expect(page).toHaveURL(/\/kumo\/me$/);

    // ほかの端末のセッションと、トークンは 401。今のセッションは残る
    expect(await meWithCookie(OTHER_DEVICE_SESSION.token)).toBe(401);
    expect(await meWithBearer(bearer)).toBe(401);
    expect(await meWithCookie(SEED_SESSIONS.lookThemed.token)).toBe(200);
    await page.reload();
    await expect(section.getByRole('heading', { level: 2, name: 'API トークン' })).toBeVisible();
    await expect(section.getByText('発行済みの API トークンはありません')).toBeVisible();

    // ほかの端末で開いていた画面は、次の読み込みで 401 になり、ログインの画面へ移る
    await otherPage.reload();
    await expect(otherPage).toHaveURL(/\/login\?return_to=%2Fkumo%2Fme$/);
    await expect(otherPage.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  } finally {
    await otherContext.close();
  }
  expect(await collect()).toEqual([]);
});

test.describe('応答を差し替える（共有の seed のセッションでは実行しない）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('確認のダイアログでやめると送らず、失敗したら知らせて、一覧は残す。実行中はボタンを押しても二重に送らない', async ({
    page,
  }) => {
    let sent = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/credentials-revoke-all')) sent++;
    });
    await page.goto('/aoba/me');
    const section = sectionOf(page);
    await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
    const rows = section.getByRole('table', { name: '発行済みの API トークン' }).locator('tbody tr');
    const rowCount = await rows.count();
    const button = section.getByRole('button', { name: BUTTON });
    const confirm = page.getByRole('dialog', { name: DIALOG });

    // やめる。送らず、フォーカスはボタンへ戻る。背景や Esc で閉じても同じ
    await button.click();
    await confirm.getByRole('button', { name: 'やめる' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect(sent).toBe(0);

    // 失敗。知らせて、一覧は残る（実際には何も無効にしていない）
    const unroute = await failOperation(page, credentialsRevokeAll, 500, 'internal');
    await button.click();
    await confirm.getByRole('button', { name: '締め出す', exact: true }).click();
    await expect(toast(page, '締め出せませんでした。時間をおいて、もう一度試してください')).toBeVisible();
    await expect(rows).toHaveCount(rowCount);
    expect(sent).toBe(1);
    await unroute();

    // 実行中は、押しても二重に送らない（応答は差し替える。本物は呼ばない）
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const unrouteSlow = await routeOperation(page, credentialsRevokeAll, async (call) => {
      await gate;
      await call.fulfill({ revoked_sessions: 0, revoked_tokens: 0 });
    });
    await button.click();
    await confirm.getByRole('button', { name: '締め出す', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.click({ force: true });
    await expect(confirm).toHaveCount(0);
    release();
    await expect(toast(page, 'ほかの端末のセッション0件と、API トークン0件を締め出しました')).toBeVisible();
    expect(sent).toBe(2);
    await unrouteSlow();
  });
});
