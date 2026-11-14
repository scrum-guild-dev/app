// 共有アカウントの所属先を変えず、専用のアカウントと組織のユーザーだけを無効化して戻す。
// OAuth は往復せず、ログイン直後と同じ新しいセッションを用意して復帰を確かめる。
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '../src/server/uuid.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionInserts } from '../scripts/seed.ts';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { meThemeUpdate, myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { userAdminUpdate, userDisable, userEnable } from '../src/shared/operations/organization/user.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { expect, test } from './fixtures.ts';
import { executeLocalD1 } from './local-d1.ts';
import { signIn } from './helpers.ts';
import { failOperation } from './operations.ts';

const notice =
  'この組織に入るには、ログインし直してください。API トークンも、ログインし直してから発行し直す必要があります。';

for (const width of [320, 390, 1024, 1280]) {
  test(`${width}px: 古い認証を断った組織からログインと再発行の案内へ移る`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(context, baseURL, 'member');
    await failOperation(page, organizationInfo, { slug: 'aoba' }, 401, 'organization_reauth_required');
    await page.goto('/aoba/me?tab=profile');
    await expect(page).toHaveURL(/\/login\?.*error=organization_reauth_required/);
    await expect(page.getByRole('alert')).toHaveText(notice);
    await expect(page.getByRole('link', { name: 'GitHub でログイン', exact: true })).toHaveAttribute(
      'href',
      '/api/auth/github/start?return_to=%2Faoba%2Fme%3Ftab%3Dprofile',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('表示中の操作も、組織の古い認証を断られたら案内へ移る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/me');
  await failOperation(page, meThemeUpdate, { slug: 'aoba' }, 401, 'organization_reauth_required');
  const theme = page.getByRole('region', { name: 'テーマ', exact: true });
  await theme.getByRole('radio', { name: 'ネオン', exact: false }).click();
  await expect(page).toHaveURL(/\/login\?.*error=organization_reauth_required/);
  await expect(page.getByRole('alert')).toHaveText(notice);
});

test('添付の送信中も、組織の古い認証を断られたら案内へ移る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401?task=019a0000-0000-7000-8000-000000000801');
  const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
  const input = drawer.getByRole('textbox', { name: 'コメントを書く', exact: true });
  await expect(input).toBeVisible();
  await page.route(`**${operationPath(attachmentUpload, 'aoba')}`, (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'organization_reauth_required', message: '' } } }),
  );
  await input
    .locator('xpath=ancestor::form')
    .locator('input[type="file"]')
    .setInputFiles({
      name: '認証.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  await expect(page).toHaveURL(/\/login\?.*error=organization_reauth_required/);
  await expect(page.getByRole('alert')).toHaveText(notice);
});

test('実際の無効化は404、戻しても旧Cookieは再ログインへ移し、新しいログインなら組織を開ける', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL が無い');
  const organizationId = uuidv7(new Date());
  const otherOrganizationId = uuidv7(new Date());
  const adminId = uuidv7(new Date());
  const memberId = uuidv7(new Date());
  const otherMemberId = uuidv7(new Date());
  const adminAccountId = uuidv7(new Date());
  const memberAccountId = uuidv7(new Date());
  const slug = `credential-${organizationId.slice(-12)}`;
  const otherSlug = `credential-other-${otherOrganizationId.slice(-12)}`;
  const created = '2026-10-01T00:00:00.000Z';
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const session = { accountId: memberAccountId, token, description: '認証確認のメンバー' };
  const adminSession = {
    accountId: adminAccountId,
    token: randomBytes(32).toString('base64url'),
    description: '認証確認の管理者',
  };
  try {
    await executeLocalD1([
      ...[
        [adminAccountId, SEED_SESSIONS.admin.accountId],
        [memberAccountId, SEED_SESSIONS.member.accountId],
      ].flatMap(([accountId, sourceId]) => [
        `INSERT INTO accounts (id, created_at, updated_at) VALUES ('${accountId}', '${created}', '${created}')`,
        `INSERT INTO account_logins (login_provider, login_subject, account_id, login_name, created_at, updated_at) VALUES ('github', '${accountId}', '${accountId}', 'credential-test', '${created}', '${created}')`,
        `INSERT INTO account_consents (account_id, terms_version, privacy_version, consented_at) SELECT '${accountId}', terms_version, privacy_version, consented_at FROM account_consents WHERE account_id = '${sourceId}'`,
      ]),
      `INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) VALUES ('${organizationId}', '${slug}', '認証確認の工房', 'github:9000000000000001', '${created}', '${created}')`,
      `INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) VALUES ('${otherOrganizationId}', '${otherSlug}', '認証確認の別工房', 'github:9000000000000001', '${created}', '${created}')`,
      `INSERT INTO users (id, organization_id, account_id, login_provider, login_subject, name, is_admin, created_at, updated_at) VALUES ('${adminId}', '${organizationId}', '${adminAccountId}', 'github', '${adminAccountId}', '認証管理者', 1, '${created}', '${created}'), ('${memberId}', '${organizationId}', '${memberAccountId}', 'github', '${memberAccountId}', '認証メンバー', 1, '${created}', '${created}'), ('${otherMemberId}', '${otherOrganizationId}', '${memberAccountId}', 'github', '${memberAccountId}', '認証メンバー', 1, '${created}', '${created}')`,
      sessionInserts([session, adminSession], new Date()),
      `UPDATE sessions SET created_at = '${created}' WHERE token_hash = '${hash}'`,
    ]);
    // 専用データが存在する間も、並列テストが使う seed の所属先に混ざらない。
    for (const seed of [SEED_SESSIONS.admin, SEED_SESSIONS.member]) {
      const response = await request.post(operationPath(myOrganizations), {
        headers: { Origin: baseURL, Cookie: `${sessionCookieName(baseURL)}=${seed.token}` },
        data: {},
      });
      expect(response.status()).toBe(200);
      const output = myOrganizations.output.parse(await response.json());
      expect(output.organizations.map((organization) => organization.slug)).not.toContain(slug);
      expect(output.organizations.map((organization) => organization.slug)).not.toContain(otherSlug);
    }
    await context.addCookies([{ name: sessionCookieName(baseURL), value: token, url: baseURL, httpOnly: true }]);
    const adminHeaders = { Origin: baseURL, Cookie: `${sessionCookieName(baseURL)}=${adminSession.token}` };
    const disable = await request.post(operationPath(userDisable, slug), {
      headers: adminHeaders,
      data: { user_id: memberId },
    });
    expect(disable.status()).toBe(200);
    const disabled = await context.request.post(operationPath(organizationInfo, slug), {
      headers: { Origin: baseURL },
      data: {},
    });
    expect(disabled.status()).toBe(404);
    for (const [definition, data] of [
      [userEnable, { user_id: memberId }],
      [userAdminUpdate, { user_id: memberId, is_admin: true }],
    ] as const) {
      expect((await request.post(operationPath(definition, slug), { headers: adminHeaders, data })).status()).toBe(200);
    }
    await page.goto(`/${slug}/admin`);
    await expect(page).toHaveURL(/\/login\?.*error=organization_reauth_required/);
    await expect(page.getByRole('alert')).toHaveText(notice);
    // 他組織では同じ Cookie のままで使える。
    await page.goto(`/${otherSlug}/me`);
    await expect(page.getByRole('heading', { name: 'マイプロフィール', exact: true })).toBeVisible();
    // ログインし直したセッションと同じ作成時刻に替える（共有 seed のセッションは変えない）。
    await executeLocalD1([
      `UPDATE sessions SET created_at = '${new Date().toISOString()}' WHERE token_hash = '${hash}'`,
    ]);
    await page.goto(`/${slug}/admin`);
    await expect(page.getByRole('table', { name: '組織のユーザーの一覧' })).toContainText('認証メンバー');
  } finally {
    await executeLocalD1([
      ...[organizationId, otherOrganizationId].flatMap((id) => [
        `DELETE FROM change_logs WHERE organization_id = '${id}'`,
        `DELETE FROM users WHERE organization_id = '${id}'`,
        `DELETE FROM organizations WHERE id = '${id}'`,
      ]),
      ...[adminAccountId, memberAccountId].flatMap((id) => [
        `DELETE FROM sessions WHERE account_id = '${id}'`,
        `DELETE FROM account_consents WHERE account_id = '${id}'`,
        `DELETE FROM account_logins WHERE account_id = '${id}'`,
        `DELETE FROM accounts WHERE id = '${id}'`,
      ]),
    ]);
  }
});
