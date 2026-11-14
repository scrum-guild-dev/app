// 組織の管理の画面のプランの節（#1190）。契約と上限を返す範囲（管理者だけ）と、運用者が変えた後の値は test/organization-plan-info.test.ts が確かめる。
// seed の組織の契約は、運用者の e2e が「未契約」を前提にしているので書かず、契約のある組織の表示と、変わった後の読み直しは organization の応答を差し替えて確かめる
import type { OutputOf } from '../src/shared/operations/define.ts';
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
  const section = page.getByRole('region', { name: 'プラン', exact: true });
  await expect(section.locator('dd').first()).toHaveText('未契約');
  // seed の組織は列の既定の上限（15 人、30 GB）
  await expect(section).toContainText('15 人');
  await expect(section).toContainText('30 GB');
  await expect(section).toContainText('まだ契約していません');
  await expect(section).toContainText('プラン、支払いの周期、追加容量を変えるときは、運用者に問い合わせてください。');
  await expect(section.getByRole('button')).toHaveCount(0);
  await expectNoA11yViolationsInThemes(page, 'admin');
});

test('契約のある組織の管理者には、契約、追加容量の口数、契約から決まる上限が出て、運用者が変えた後に開き直すと新しい契約が出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  // 運用者が契約を変えたことを、応答の差し替えで表す。プランの節は組織の枠の値を使わず、管理画面へ入るたびに読み直す
  let plan: OutputOf<typeof organizationInfo>['plan'] = {
    contract: {
      plan: 'business' as const,
      billing_interval: 'yearly' as const,
      extra_10gb_units: 0,
      extra_50gb_units: 1,
    },
    member_limit: 50,
    attachment_quota_bytes: 150 * GIB,
  };
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    trial: null,
    plan: output.plan === null ? null : plan,
  }));
  await page.goto('/aoba/admin');
  const section = page.getByRole('region', { name: 'プラン', exact: true });
  await expect(section.locator('dd').first()).toHaveText('ビジネス・年払い');
  await expect(section).toContainText('+50\u00a0GB\u00a0×\u00a01\u00a0口');
  await expect(section).toContainText('50\u00a0人');
  await expect(section).toContainText('150\u00a0GB');
  await expect(section).not.toContainText('未契約');
  await expect(section).toContainText('運用者に問い合わせてください。');

  plan = {
    contract: { plan: 'team' as const, billing_interval: 'monthly' as const, extra_10gb_units: 0, extra_50gb_units: 0 },
    member_limit: 15,
    attachment_quota_bytes: 30 * GIB,
  };
  // ページを読み込み直さず（組織の枠を保ったまま）、パンくずの組織から最初の画面へ移り、アカウントのメニューから管理画面へ戻る
  await page.locator('.breadcrumb').getByRole('link', { name: 'あおば開発' }).click();
  await expect(page).toHaveURL(/\/aoba\/?$/);
  await page.getByRole('button', { name: /アカウントのメニュー$/ }).click();
  await page.locator('.account-menu-list').getByRole('link', { name: '組織の管理' }).click();
  await expect(section.locator('dd').first()).toHaveText('チーム・月払い');
  await expect(section).toContainText('なし');
  await expect(section).toContainText('30\u00a0GB');
  // 同じ organization 操作を読む容量の節も待ち、差し替え中の応答をテスト終了で切らない
  await expect(page.getByRole('region', { name: '添付ファイルと Wiki の容量' }).locator('table')).toBeVisible();
});

test('メンバーには組織の管理の画面もプランの節も出ない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/aoba/admin');
  await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'プラン', exact: true })).toHaveCount(0);
});
