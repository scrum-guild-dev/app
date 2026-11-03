import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { rewriteOperation } from './operations.ts';
import { operationPath, type OutputOf } from '../src/shared/operations/define.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test('お試しの管理者は管理の先頭で期限と残りの日数を見られる', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'trialAdmin');
  const collect = await watchViolations(page);
  await rewriteOperation(page, organizationInfo, { slug: 'kaze' }, (result) => ({
    ...result,
    trial: { ends_on: '2028-02-29', days_left: 30 },
  }));
  const response = page.waitForResponse((res) => res.url().endsWith(operationPath(organizationInfo, 'kaze')));
  await page.goto('/kaze/admin');
  const result = (await (await response).json()) as OutputOf<typeof organizationInfo>;
  expect(result.trial).not.toBeNull();
  const section = page.getByRole('region', { name: 'お試し', exact: true });
  await expect(page.locator('.settings > section').first()).toHaveAccessibleName('お試し');
  await expect(section).toContainText('2028/03/01 09:00 ごろに止まります');
  await expect(section).not.toContainText('UTC');
  await expect(section).toContainText(`残り ${result.trial!.days_left} 日`);
  await expect(section).toContainText('継続して使うには、運用者に問い合わせてください。');
  expect(await collect()).toEqual([]);
});

test('お試しのメンバーには管理の節も API の期限の値も出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'trialMember');
  const response = page.waitForResponse((res) => res.url().endsWith(operationPath(organizationInfo, 'kaze')));
  await page.goto('/kaze/admin');
  expect(((await (await response).json()) as OutputOf<typeof organizationInfo>).trial).toBeNull();
  await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'お試し', exact: true })).toHaveCount(0);
});

test('期限のない組織の管理者にはお試しの節を出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/aoba/admin');
  await expect(page.getByRole('heading', { level: 1, name: '組織の管理' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'お試し', exact: true })).toHaveCount(0);
});

for (const days_left of [0, -1]) {
  test(`期限の当日と期限切れの案内を保つ（残り ${days_left} 日）`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'trialAdmin');
    await rewriteOperation(page, organizationInfo, { slug: 'kaze' }, (result) => ({
      ...result,
      trial: { ends_on: '2028-02-29', days_left },
    }));
    await page.goto('/kaze/admin');
    const section = page.getByRole('region', { name: 'お試し', exact: true });
    await expect(section).toContainText('2028/03/01 09:00 ごろに止まります');
    await expect(section).toContainText(days_left === 0 ? '今日までです' : 'お試しの期限を過ぎています');
    await expect(section).not.toContainText('残り');
  });
}
