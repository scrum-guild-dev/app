// 組織の無い会員が、組織を作ってその組織へ移る流れ。手元では実行せず、CI の e2e で確かめる。
import type { Page } from '@playwright/test';
import { createPersonalOrganization, myOrganizations } from '../src/shared/operations/organization/index.ts';
import { word } from '../src/shared/vocabulary.ts';
import { expect, test } from './fixtures.ts';
import { expectFocusReturned, findA11yViolations, signIn } from './helpers.ts';
import { removeCreatedOrganizations } from './local-d1.ts';
import { failOperation, rewriteOperation } from './operations.ts';

// 作った組織は API に消す操作が無く、お試し中の組織は1アカウントに1つまでなので、テストの前と後に seed の状態（組織の無い会員）へ戻す
// （e2e/local-d1.ts）。繰り返し（--repeat-each）でも毎回組織の無い状態から始める。この会員を使うテストはこのファイルにまとめる
test.beforeEach(async () => {
  await removeCreatedOrganizations('createOrg');
});
test.afterEach(async () => {
  await removeCreatedOrganizations('createOrg');
});

async function openDialog(page: Page) {
  await page.goto('/');
  await expect(page.getByText('入れる組織がありません', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '組織を作る' }).click();
  const dialog = page.getByRole('dialog', { name: word('createMyOrganizationTitle') });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('組織の無い会員は「組織を作る」から作成後の組織へ移る', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openDialog(page);
  await dialog.getByLabel('URL の名前（slug）').fill('nagi-trial');
  await dialog.getByLabel('組織の名前').fill('ナギの工房');
  await dialog.getByRole('button', { name: '組織を作る' }).click();
  await expect(page).toHaveURL(/\/nagi-trial\/?$/);
});

test('80 字を超える名前は黙って切られず、名前の欄に理由が出て、組織は作られない', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openDialog(page);
  await dialog.getByLabel('URL の名前（slug）').fill('nagi-long');
  const longName = 'あ'.repeat(81);
  await dialog.getByLabel('組織の名前').fill(longName);
  // 欄が値を切らない（maxlength が無い）。上限は、送る前から欄の下のヒントに出ている
  await expect(dialog.getByLabel('組織の名前')).not.toHaveAttribute('maxlength');
  await expect(dialog.getByLabel('組織の名前')).toHaveValue(longName);
  await expect(dialog.getByLabel('組織の名前')).toHaveAccessibleDescription(
    word('createMyOrganizationNameHint', { max: '80' }),
  );
  await dialog.getByRole('button', { name: '組織を作る' }).click();
  await expect(
    dialog.getByText(word('createMyOrganizationNameLong', { organization: word('organization'), max: '80' })),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/\/nagi-long/);
});

test('すでにある組織の slug を入れると、ダイアログに理由が出て、組織は作られない', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openDialog(page);
  // seed の組織（aoba）と同じ slug
  await dialog.getByLabel('URL の名前（slug）').fill('aoba');
  await dialog.getByLabel('組織の名前').fill('ナギの工房');
  await dialog.getByRole('button', { name: '組織を作る' }).click();
  await expect(dialog.getByText(word('createMyOrganizationSlugTaken'))).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page).not.toHaveURL(/\/aoba/);
});

// 入れる組織が1つで招待が無い会員（ハルカ）は / を開くとその組織へ移り、組織の選択の画面に届かない。切り替えのメニューが入口になる。
// ハルカで組織を作ると手元の D1 に組織が残り、繰り返し（e2e-repeat）が崩れるので、作成までは進めず、開いて、やめるで閉じるところまで確かめる
test('入れる組織が1つの会員は、組織の切り替えのメニューから「組織を作る」を開き、閉じるとフォーカスが切り替えのボタンへ戻る', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/');
  await expect(page).toHaveURL(/\/aoba$/);
  const menuButton = page.getByRole('button', { name: 'あおば開発。組織を切り替える' });
  await menuButton.click();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('list', { name: '入れる組織' }).getByRole('button', { name: '組織を作る' }).click();

  const dialog = page.getByRole('dialog', { name: word('createMyOrganizationTitle') });
  await expect(dialog).toBeVisible();
  // メニューは閉じて、ダイアログは残っている
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByRole('button', { name: word('cancel') }).click();
  await expect(dialog).toBeHidden();
  await expectFocusReturned(page, menuButton);
  await expect(page).toHaveURL(/\/aoba$/);
});

// 入れる組織が1つで招待が無い会員（ハルカ）は組織の選択の画面に届かないので、切り替えのメニューの「自分用を作る」が自分用の入口になる（#733）。
// 作成までは進めず、開いて、やめるで閉じるところまで確かめる（手元の D1 に自分用の組織を残さない）
test('入れる組織が1つの会員は、組織の切り替えのメニューから「自分用を作る」を開き、閉じるとフォーカスが切り替えのボタンへ戻る', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'member');
  await page.goto('/');
  await expect(page).toHaveURL(/\/aoba$/);
  const menuButton = page.getByRole('button', { name: 'あおば開発。組織を切り替える' });
  await menuButton.click();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('list', { name: '入れる組織' });
  // 「組織を作る」の次に並ぶ
  await expect(list.getByRole('button')).toHaveText([
    word('createMyOrganizationAction'),
    word('createPersonalOrganizationAction'),
  ]);
  await list.getByRole('button', { name: word('createPersonalOrganizationAction') }).click();

  const dialog = page.getByRole('dialog', { name: word('createPersonalOrganizationTitle', { organization: '組織' }) });
  await expect(dialog).toBeVisible();
  // メニューは閉じて、ダイアログは残っている。入れるのは slug だけ
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await dialog.getByRole('button', { name: word('cancel') }).click();
  await expect(dialog).toBeHidden();
  await expectFocusReturned(page, menuButton);
  await expect(page).toHaveURL(/\/aoba$/);
});

test('自分用を持つ会員の切り替えのメニューには、名前の代わりに「自分用」が並び、「自分用を作る」は出ない。停止した自分用があるときも出ない', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'member');
  const team = { slug: 'aoba', name: 'あおば開発', kind: 'team' as const };
  const personal = { slug: 'mio-solo', name: '自分用', kind: 'personal' as const };
  const unroute = await rewriteOperation(page, myOrganizations, (output) => ({
    ...output,
    organizations: [team, personal],
  }));
  await page.goto('/aoba');
  await page.getByRole('button', { name: 'あおば開発。組織を切り替える' }).click();
  const list = page.getByRole('list', { name: '入れる組織' });
  await expect(list.getByRole('link', { name: '自分用' })).toBeVisible();
  await expect(list.getByRole('button', { name: word('createMyOrganizationAction') })).toBeVisible();
  await expect(list.getByRole('button', { name: word('createPersonalOrganizationAction') })).toHaveCount(0);

  // 自分用が入れる組織に無く、停止した組織にあるときも出さない
  await unroute();
  await rewriteOperation(page, myOrganizations, (output) => ({
    ...output,
    organizations: [team],
    suspended: [{ ...personal, slug: 'mio-stopped' }],
  }));
  await page.goto('/aoba');
  await page.getByRole('button', { name: 'あおば開発。組織を切り替える' }).click();
  await expect(list.getByRole('button', { name: word('createMyOrganizationAction') })).toBeVisible();
  await expect(list.getByRole('button', { name: word('createPersonalOrganizationAction') })).toHaveCount(0);
});

// 自分用（#733）。組織の無い会員（ナギ）が、slug だけを入れて自分用の組織を作る。作った組織は afterEach が消す
async function openPersonalDialog(page: Page) {
  await page.goto('/');
  await expect(page.getByText('入れる組織がありません', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: word('createPersonalOrganizationAction') }).click();
  const dialog = page.getByRole('dialog', { name: word('createPersonalOrganizationTitle', { organization: '組織' }) });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('組織の無い会員は「自分用を作る」から slug だけで作り、その組織へ入って「自分用」と出る', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openPersonalDialog(page);
  // 入れるのは slug だけ（名前の欄は無い）
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await dialog.getByLabel('URL の名前（slug）').fill('nagi-solo');
  await dialog.getByRole('button', { name: word('createPersonalOrganizationSubmit') }).click();
  await expect(page).toHaveURL(/\/nagi-solo\/?$/);
  // 組織の切り替えのボタンに、組織の名前の代わりに「自分用」と出る
  await expect(page.getByRole('button', { name: '自分用。組織を切り替える' })).toBeVisible();
});

test('すでにある slug を入れると、ダイアログの slug の欄に理由が出て、選び直せる', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openPersonalDialog(page);
  // seed の組織（aoba）と同じ slug
  await dialog.getByLabel('URL の名前（slug）').fill('aoba');
  await dialog.getByRole('button', { name: word('createPersonalOrganizationSubmit') }).click();
  await expect(dialog.getByText(word('createMyOrganizationSlugTaken'))).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page).not.toHaveURL(/\/aoba/);

  // 入れ直して、別の slug で作れる
  await dialog.getByLabel('URL の名前（slug）').fill('nagi-solo-2');
  await dialog.getByRole('button', { name: word('createPersonalOrganizationSubmit') }).click();
  await expect(page).toHaveURL(/\/nagi-solo-2\/?$/);
});

test('slug の形が合わないと、送らずに slug の欄に理由が出る。やめるで閉じると、フォーカスが開いたボタンへ戻る', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  const dialog = await openPersonalDialog(page);
  await dialog.getByLabel('URL の名前（slug）').fill('Nagi Solo');
  await dialog.getByRole('button', { name: word('createPersonalOrganizationSubmit') }).click();
  await expect(dialog.getByText(word('createMyOrganizationSlugFormat'))).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await dialog.getByRole('button', { name: word('cancel') }).click();
  await expect(dialog).toBeHidden();
  await expectFocusReturned(page, page.getByRole('button', { name: word('createPersonalOrganizationAction') }));
});

// 入れる組織の一覧は、応答を書き換えて作る（共有の seed の組織に自分用を足すと、並べて走るほかのテストが崩れるため）。
// サーバーの判定（kind を返す、2つ目を断る）は test/create-personal-organization.test.ts と test/organization-kind.test.ts
test.describe('組織の選択の「自分用を作る」の出し分け', () => {
  const team = { slug: 'aoba', name: 'あおば開発', kind: 'team' as const };
  const personal = { slug: 'mio-solo', name: '自分用', kind: 'personal' as const };

  test('自分用を持つ人には出さず、自分用はチーム用と並んで「自分用」と出る', async ({ context, baseURL, page }) => {
    await signIn(context, baseURL, 'createOrg');
    await rewriteOperation(page, myOrganizations, (output) => ({ ...output, organizations: [team, personal] }));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '組織を選ぶ' })).toBeVisible();
    await expect(page.locator('.choice')).toHaveText([/あおば開発/, /自分用/]);
    await expect(page.getByRole('button', { name: word('createMyOrganizationAction') })).toBeVisible();
    await expect(page.getByRole('button', { name: word('createPersonalOrganizationAction') })).toHaveCount(0);
  });

  test('自分用を持つが停止して入れない人にも出さず、停止している組織の欄に「自分用」と出る', async ({
    context,
    baseURL,
    page,
  }) => {
    await signIn(context, baseURL, 'createOrg');
    await rewriteOperation(page, myOrganizations, (output) => ({
      ...output,
      // 入れる組織が1つだと組織へ直に移るので、選択の画面を出すために2つにする
      organizations: [team, { ...team, slug: 'other-team', name: 'もう一つのチーム' }],
      suspended: [{ ...personal, slug: 'mio-stopped' }],
    }));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '組織を選ぶ' })).toBeVisible();
    await expect(page.locator('.choice.is-static')).toHaveText([/自分用/]);
    await expect(page.getByText(word('suspendedOrganizationStatus'))).toBeVisible();
    await expect(page.getByRole('button', { name: word('createPersonalOrganizationAction') })).toHaveCount(0);
  });

  test('チーム用だけの人には、「組織を作る」の隣に「自分用を作る」が出る', async ({ context, baseURL, page }) => {
    await signIn(context, baseURL, 'createOrg');
    await rewriteOperation(page, myOrganizations, (output) => ({
      ...output,
      organizations: [team, { slug: 'hibari', name: 'ひばり工房', kind: 'team' as const }],
    }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: word('createMyOrganizationAction') })).toBeVisible();
    await expect(page.getByRole('button', { name: word('createPersonalOrganizationAction') })).toBeVisible();
    expect(await findA11yViolations(page)).toEqual([]);
  });

  test('すでに自分用を持つ人が押すと、ダイアログに断りと組織の一覧へのリンクが出る', async ({
    context,
    baseURL,
    page,
  }) => {
    await signIn(context, baseURL, 'createOrg');
    // 自分用を持つが、画面の一覧には出ていない人（応答を書き換えて入口を出し、サーバーの断りを受ける）
    await rewriteOperation(page, myOrganizations, (output) => ({
      ...output,
      organizations: [team, { slug: 'hibari', name: 'ひばり工房', kind: 'team' as const }],
    }));
    await failOperation(page, createPersonalOrganization, 409, 'conflict', { details: { reason: 'personal_limit' } });
    await page.goto('/');
    await page.getByRole('button', { name: word('createPersonalOrganizationAction') }).click();
    const dialog = page.getByRole('dialog', {
      name: word('createPersonalOrganizationTitle', { organization: '組織' }),
    });
    await dialog.getByLabel('URL の名前（slug）').fill('nagi-again');
    await dialog.getByRole('button', { name: word('createPersonalOrganizationSubmit') }).click();
    await expect(dialog.getByText(/自分用の組織は、1つのアカウントにつき1つまでです/)).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: word('createMyOrganizationTrialLimitLink', { organization: '組織' }) }),
    ).toBeVisible();
  });
});
