// 組織の管理の画面のプランの節（#1190）。契約と上限を返す範囲（管理者だけ）と、運用者が変えた後の値は test/organization-plan-info.test.ts が確かめる。
// seed の組織の契約は、運用者の e2e が「未契約」を前提にしているので書かず、契約のある組織の表示は organization の応答を差し替えて確かめる
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const GIB = 1024 ** 3;

test('未契約の組織の管理者には、プランの節に「未契約」と今の上限と問い合わせの案内が出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/aoba/admin');
  const section = page.getByRole('region', { name: 'プラン' });
  await expect(section.locator('dd').first()).toHaveText('未契約');
  // seed の組織は列の既定の上限（15 人、30 GB）
  await expect(section).toContainText('15 人');
  await expect(section).toContainText('30 GB');
  await expect(section).toContainText('まだ契約していません');
  await expect(section).toContainText('プラン、支払いの周期、追加容量を変えるときは、運用者に問い合わせてください。');
  await expect(section.getByRole('button')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'admin');
});

test('契約のある組織の管理者には、契約、追加容量の口数、契約から決まる上限が出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    trial: null,
    plan: {
      contract: {
        plan: 'business' as const,
        billing_interval: 'yearly' as const,
        extra_10gb_units: 0,
        extra_50gb_units: 1,
      },
      member_limit: 50,
      attachment_quota_bytes: 150 * GIB,
    },
  }));
  await page.goto('/aoba/admin');
  const section = page.getByRole('region', { name: 'プラン' });
  await expect(section.locator('dd').first()).toHaveText('ビジネス・年払い');
  await expect(section).toContainText('+50 GB × 1 口');
  await expect(section).toContainText('50 人');
  await expect(section).toContainText('150 GB');
  await expect(section).not.toContainText('未契約');
  await expect(section).toContainText('運用者に問い合わせてください。');
});

test('メンバーには組織の管理の画面もプランの節も出ない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/admin');
  await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'プラン' })).toHaveCount(0);
});
