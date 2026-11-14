import { expect, test } from './fixtures.ts';
import { findA11yViolations, findOverflowViolations, findTargetSizeViolations, NARROW_VIEWPORT } from './helpers.ts';

const preview = '/signup/preview';
const account = 'Google で続ける（見本）';
const addTeam = 'チームを作って招待する';
const noTeam = '今は招待せずに見本を終える';

test('プロフィールで全員の個人用URLを設定し、招待時までチーム利用を尋ねない。招待しなければ3画面で終了', async ({
  page,
}) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url());
  });
  await page.goto('/signup');
  await page.getByRole('link', { name: '利用開始の流れを見る（プレビュー）' }).click();
  await page.getByRole('button', { name: account, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('プロフィールを設定');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByLabel('表示する名前').fill('ユイ');
  await page.getByLabel('個人用のURL', { exact: true }).fill('yui');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('チームメイトを招待');
  await expect(page.getByText('3 ステップ中 3', { exact: true })).toBeVisible();
  await expect(page.locator('.onboarding-progress > li')).toHaveCount(3);
  await expect(page.getByLabel('組織の名前', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('メールアドレス', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByLabel('個人用のURL', { exact: true })).toHaveValue('yui');
  await expect(page.getByLabel('表示する名前')).toHaveValue('ユイ');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('link', { name: noTeam, exact: true }).click();
  await expect(page).toHaveURL('/signup');
  await page.goto(preview);
  await page.getByRole('button', { name: account, exact: true }).click();
  await expect(page.getByLabel('個人用のURL', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Scrum Guild をはじめる');
  expect(writes).toEqual([]);
});

test('招待する場合だけ組織を追加し、個人用URLとチーム用URLを別々に保持する', async ({ page }) => {
  await page.goto(preview);
  await page.getByRole('button', { name: account, exact: true }).click();
  await page.getByLabel('個人用のURL', { exact: true }).fill('yui');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: addTeam, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('組織を作成');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByLabel('チーム用のURL', { exact: true })).toHaveValue('');
  await page.getByLabel('組織の名前', { exact: true }).fill('ひばり工房');
  await page.getByLabel('チーム用のURL', { exact: true }).fill('hibari');
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByLabel('個人用のURL', { exact: true })).toHaveValue('yui');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: addTeam, exact: true }).click();
  await expect(page.getByLabel('チーム用のURL', { exact: true })).toHaveValue('hibari');
  await expect(page.getByLabel('組織の名前', { exact: true })).toHaveValue('ひばり工房');
  await page.getByRole('button', { name: '作成後の画面を見る', exact: true }).click();
  await page.getByLabel('メールアドレス', { exact: true }).fill('ren@example.com');
  await page.getByRole('button', { name: '招待リンクの案内を見る' }).click();
  await expect(page.getByRole('status').filter({ hasText: '発行・コピーされません' })).toBeVisible();
  await expect(page.getByText('5 ステップ中 5', { exact: true })).toBeVisible();
  await expect(page.locator('.onboarding-progress > li')).toHaveCount(5);
  await page.getByRole('link', { name: '見本を終えて会員登録へ' }).click();
  await expect(page).toHaveURL('/signup');
});

for (const theme of ['simple_light', 'simple_dark', 'modern']) {
  for (const withTeam of [false, true]) {
    test(`390pxのプロフィールと招待の流れ（${theme}・チーム追加${withTeam ? 'あり' : 'なし'}）`, async ({ page }) => {
      await page.setViewportSize(NARROW_VIEWPORT);
      await page.goto(preview);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      const next = [account, '次へ', addTeam, '作成後の画面を見る'];
      const count = withTeam ? 5 : 3;
      for (let step = 0; step < count; step++) {
        await expect(page.locator('.onboarding-progress [aria-current="step"]')).toHaveCount(1);
        expect(await findOverflowViolations(page)).toEqual([]);
        expect(await findTargetSizeViolations(page)).toEqual([]);
        expect(await findA11yViolations(page)).toEqual([]);
        if (step < count - 1) await page.getByRole('button', { name: next[step], exact: true }).click();
      }
      await page.getByRole('link', { name: withTeam ? 'スキップして会員登録へ' : noTeam, exact: true }).click();
      await expect(page).toHaveURL('/signup');
    });
  }
}
