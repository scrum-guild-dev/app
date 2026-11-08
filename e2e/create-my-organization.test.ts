// 組織の無い会員が、組織を作ってその組織へ移る流れ。手元では実行せず、CI の e2e で確かめる。
import type { Page } from '@playwright/test';
import {
  createMyOrganization,
  createPersonalOrganization,
  myOrganizations,
} from '../src/shared/operations/organization/index.ts';
import { word } from '../src/shared/vocabulary.ts';
import { expect, test } from './fixtures.ts';
import {
  applyTheme,
  expectFocusReturned,
  findA11yViolations,
  findOverflowViolations,
  findTargetSizeViolations,
  NARROW_VIEWPORT,
  signIn,
} from './helpers.ts';
import { executeLocalD1, removeCreatedOrganizations } from './local-d1.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { workspaceList } from '../src/shared/operations/workspace/workspace-list.ts';
import { workspaceClose } from '../src/shared/operations/workspace/workspace-close.ts';
import { invitationCreate } from '../src/shared/operations/workspace/invitation-create.ts';
import { accountProfileSave, onboardingStatus } from '../src/shared/operations/session/onboarding.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';

// 作った組織は API に消す操作が無く、お試し中の組織は1アカウントに1つまでなので、テストの前と後に seed の状態（組織の無い会員）へ戻す
// （e2e/local-d1.ts）。繰り返し（--repeat-each）でも毎回組織の無い状態から始める。この会員を使うテストはこのファイルにまとめる
test.beforeEach(async () => {
  await removeCreatedOrganizations('createOrg');
  await executeLocalD1([`DELETE FROM account_profiles WHERE account_id = '${SEED_SESSIONS.createOrg.accountId}';`]);
});
test.afterEach(async () => {
  await removeCreatedOrganizations('createOrg');
  await executeLocalD1([`DELETE FROM account_profiles WHERE account_id = '${SEED_SESSIONS.createOrg.accountId}';`]);
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

// createOrgの会員を共有するので、このファイルにまとめる。プロフィールと作成組織は前後で戻す。
test('登録後の設定でプロフィールと自分用を保存し、再読み込み後に重ねて作らず個人用へ進む', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  let creations = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/create-personal-organization') creations++;
  });
  await page.goto('/auth/setup');
  await page.getByLabel('表示する名前').fill('導入 ユイ');
  await page.getByLabel('役割・肩書き（任意）').fill('エンジニア');
  await page.getByLabel('個人用のURL', { exact: true }).fill('setup-solo');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('チームメイトを招待');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('チームメイトを招待');
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByLabel('個人用のURL', { exact: true })).toHaveValue('setup-solo');
  await expect(page.getByLabel('個人用のURL', { exact: true })).toHaveAttribute('readonly');
  await expect(page.getByLabel('表示する名前')).toHaveValue('導入 ユイ');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('link', { name: '個人用で使い始める', exact: true }).click();
  await expect(page).toHaveURL(/\/setup-solo$/);
  const response = await page.request.post('/api/setup-solo/organization', {
    headers: { Origin: new URL(baseURL!).origin },
    data: {},
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).me.name).toBe('導入 ユイ');
  expect(creations).toBe(1);
});

test('チーム利用は自分用の保存後に選び、組織・ワークスペース・本物の招待リンクを作る', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  await page.goto('/auth/setup');
  await page.getByLabel('表示する名前').fill('導入 ユイ');
  await page.getByLabel('個人用のURL', { exact: true }).fill('setup-own');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: 'チームを作って招待する', exact: true }).click();
  await page.getByLabel('組織の名前', { exact: true }).fill('導入の工房');
  await page.getByLabel('チーム用のURL', { exact: true }).fill('setup-team');
  await page.getByRole('button', { name: '組織を作って進む', exact: true }).click();
  await expect(page.getByLabel('招待するGoogleアカウントのメールアドレス')).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/setup\?team=setup-team/);
  await page.getByLabel('招待するGoogleアカウントのメールアドレス').fill('setup-new@example.com');
  await page.getByRole('button', { name: '招待リンクを作成', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'setup-new@example.com', exact: true })).toHaveValue(
    /\/invite#[A-Za-z0-9_-]{43}/,
  );
  await expect(page.getByText('メールは送信しません。', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'チームで使い始める', exact: true }).click();
  await expect(page).toHaveURL(/\/setup-team\/w\/[^/]+$/);
  await expect(page.locator('.app')).toBeVisible();
});

test('プロフィール保存に失敗しても入力を保持し、自分用は作らず再試行できる', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'createOrg');
  await page.goto('/auth/setup');
  await page.getByLabel('表示する名前').fill('導入 ユイ');
  await page.getByLabel('個人用のURL', { exact: true }).fill('setup-retry');
  const stopFailing = await failOperation(page, accountProfileSave, 503, 'unavailable');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('プロフィールを保存できませんでした');
  await expect(page.getByLabel('個人用のURL', { exact: true })).toHaveValue('setup-retry');
  await stopFailing();
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('チームメイトを招待');
});

test('利用開始の保存する画面は390px・4テーマで表示と操作対象に問題がない', async ({ context, baseURL, page }) => {
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'createOrg');
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/auth/setup');
  const actions = ['次へ', 'チームを作って招待する', '組織を作って進む'];
  for (let stage = 0; stage < 4; stage++) {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const theme of ['simple_light', 'simple_dark', 'medieval', 'modern']) {
      await applyTheme(page, theme);
      expect(await findOverflowViolations(page)).toEqual([]);
      expect(await findTargetSizeViolations(page)).toEqual([]);
      expect(await findA11yViolations(page)).toEqual([]);
    }
    if (stage === 0) {
      await page.getByLabel('表示する名前').fill('導入 ユイ');
      await page.getByLabel('個人用のURL', { exact: true }).fill('setup-visual-own');
    }
    if (stage === 2) {
      await page.getByLabel('組織の名前', { exact: true }).fill('導入の工房');
      await page.getByLabel('チーム用のURL', { exact: true }).fill('setup-visual-team');
    }
    if (stage < 3) await page.getByRole('button', { name: actions[stage], exact: true }).click();
  }
});

test('チーム作成の応答だけを失っても、作成済みの同じチームで招待へ進む', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'createOrg');
  let creations = 0;
  await routeOperation(page, createMyOrganization, async (call) => {
    creations++;
    await call.fetch();
    await call.abort();
  });
  await page.goto('/auth/setup');
  await page.getByLabel('表示する名前').fill('導入 ユイ');
  await page.getByLabel('個人用のURL', { exact: true }).fill('setup-lost-own');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: 'チームを作って招待する', exact: true }).click();
  await page.getByLabel('組織の名前', { exact: true }).fill('導入の工房');
  await page.getByLabel('チーム用のURL', { exact: true }).fill('setup-lost-team');
  await page.getByRole('button', { name: '組織を作って進む', exact: true }).click();
  await expect(page.getByLabel('招待するGoogleアカウントのメールアドレス')).toBeVisible();
  await expect(page).toHaveURL(/team=setup-lost-team/);
  await page.reload();
  await expect(page.getByLabel('招待するGoogleアカウントのメールアドレス')).toBeVisible();
  expect(creations).toBe(1);
});

test('招待の部分失敗は宛先ごとに読み上げられ、成功URLを保って再試行・コピーできる', async ({
  context,
  baseURL,
  page,
}) => {
  const email = 'a'.repeat(64) + '@example.com';
  await signIn(context, baseURL, 'createOrg');
  await page.setViewportSize(NARROW_VIEWPORT);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/auth/setup');
  await page.getByLabel('個人用のURL', { exact: true }).fill('setup-invite-own');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: 'チームを作って招待する', exact: true }).click();
  await page.getByLabel('組織の名前', { exact: true }).fill('招待の工房');
  await page.getByLabel('チーム用のURL', { exact: true }).fill('setup-invite-team');
  await page.getByRole('button', { name: '組織を作って進む', exact: true }).click();
  const counts = { good: 0, retry: 0 };
  const stopFailing = await routeOperation(page, invitationCreate, { slug: 'setup-invite-team' }, async (call) => {
    if (call.input.provider === 'google' && call.input.email === 'retry@example.com') {
      counts.retry++;
      await call.fail(503, 'unavailable');
    } else {
      counts.good++;
      await call.passThrough();
    }
  });
  await page.getByLabel('招待するGoogleアカウントのメールアドレス').fill(`${email},retry@example.com`);
  await page.getByRole('button', { name: '招待リンクを作成', exact: true }).click();
  await expect(page.getByRole('group', { name: 'retry@example.com', exact: true })).toContainText(
    word('onboardingInvitationFailed'),
  );
  const good = page.getByRole('textbox', { name: email, exact: true });
  await expect(good).toHaveValue(/\/invite#/);
  const url = await good.inputValue();
  expect(await findA11yViolations(page)).toEqual([]);
  await page.getByRole('button', { name: `${word('onboardingCopyLink')} ${email}`, exact: true }).click();
  await expect(page.locator('.onboarding-notice[role="status"]')).toContainText(word('onboardingCopied', { email }));
  await expect(page.locator('.onboarding-notice[role="status"]')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await page.getByRole('button', { name: `${word('onboardingCopyLink')} ${email}`, exact: true }).click();
  await expect(page.locator('.onboarding-notice[role="status"]')).toContainText(word('onboardingCopied', { email }));
  expect(await findOverflowViolations(page)).toEqual([]);
  await stopFailing();
  await page.getByRole('button', { name: '招待リンクを作成', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'retry@example.com', exact: true })).toHaveValue(/\/invite#/);
  await expect(good).toHaveValue(url);
  expect(counts).toEqual({ good: 1, retry: 1 });
});

test('閉じたワークスペースしかないチームの再開は招待へ進まず、組織へ戻れる', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'createOrg');
  await page.goto('/auth/setup');
  await page.getByLabel('個人用のURL', { exact: true }).fill('setup-closed-own');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: 'チームを作って招待する', exact: true }).click();
  await page.getByLabel('組織の名前', { exact: true }).fill('再開の工房');
  await page.getByLabel('チーム用のURL', { exact: true }).fill('setup-closed-team');
  await page.getByRole('button', { name: '組織を作って進む', exact: true }).click();
  await expect(page.getByLabel('招待するGoogleアカウントのメールアドレス')).toBeVisible();
  const response = await page.request.post(operationPath(workspaceList, 'setup-closed-team'), {
    headers: { Origin: new URL(baseURL!).origin },
    data: {},
  });
  expect(response.status()).toBe(200);
  const { workspaces } = await response.json();
  expect(workspaces).toHaveLength(1);
  const closed = await page.request.post(operationPath(workspaceClose, 'setup-closed-team'), {
    headers: { Origin: new URL(baseURL!).origin },
    data: { workspace_id: workspaces[0].id },
  });
  expect(closed.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(word('onboardingTeamUnavailable'));
  await expect(page.getByLabel('招待するGoogleアカウントのメールアドレス')).toHaveCount(0);
  expect(await findA11yViolations(page)).toEqual([]);
  await page.getByRole('link', { name: word('onboardingOpenTeam') }).click();
  await expect(page).toHaveURL(/\/setup-closed-team$/);
});

test('作成前からある管理対象のチームを、失敗した新規作成の回復先にしない', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'createOrg');
  const created = await page.request.post(operationPath(createMyOrganization), {
    headers: { Origin: new URL(baseURL!).origin },
    data: { slug: 'setup-existing-team', name: '既存の工房' },
  });
  expect(created.status()).toBe(200);
  await page.goto('/auth/setup');
  await page.getByLabel('個人用のURL', { exact: true }).fill('setup-existing-own');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: 'チームを作って招待する', exact: true }).click();
  await page.getByLabel('組織の名前', { exact: true }).fill('既存の工房');
  await page.getByLabel('チーム用のURL', { exact: true }).fill('setup-existing-team');
  await page.getByRole('button', { name: '組織を作って進む', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).not.toHaveURL(/team=setup-existing-team/);
  await expect(page.getByLabel('招待するGoogleアカウントのメールアドレス')).toHaveCount(0);
  const listed = await page.request.post(operationPath(workspaceList, 'setup-existing-team'), {
    headers: { Origin: new URL(baseURL!).origin },
    data: {},
  });
  expect(listed.status()).toBe(200);
  expect((await listed.json()).workspaces).toEqual([]);
});

test('個人用だけ作成済みなら未保存のプロフィールを案内し、100文字の絵文字も保存できる', async ({
  context,
  baseURL,
  page,
}) => {
  await signIn(context, baseURL, 'createOrg');
  let creations = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === operationPath(createPersonalOrganization)) creations++;
  });
  const created = await page.request.post(operationPath(createPersonalOrganization), {
    headers: { Origin: new URL(baseURL!).origin },
    data: { slug: 'setup-prior-own' },
  });
  expect(created.status()).toBe(200);
  await page.goto('/auth/setup');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(word('onboardingProfile'));
  await expect(page.getByLabel('個人用のURL', { exact: true })).toHaveAttribute('readonly');
  await expect(page.locator('#setup-personal-hint')).toHaveText('作成済みの個人用URLです。あとから変更できません。');
  await expect(page.getByText('プロフィールは保存済みです。', { exact: false })).toHaveCount(0);
  const name = '🙂'.repeat(100);
  await page.getByLabel('表示する名前').fill(name);
  await page.getByLabel('役割・肩書き（任意）').fill(name);
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(word('onboardingInviteChoice'));
  const status = await page.request.post(operationPath(onboardingStatus), {
    headers: { Origin: new URL(baseURL!).origin },
    data: {},
  });
  expect(status.status()).toBe(200);
  const saved = await status.json();
  expect(saved.profile).toEqual({ name, title: name });
  expect(saved.personal.slug).toBe('setup-prior-own');
  expect(creations).toBe(0); // APIRequestContextで先に作った1件の後、画面は作成を送っていない。
});
for (const profile of [null, { name: '導入 ユイ', title: '' }]) {
  test(`入れない個人用は準備完了や招待を案内しない（プロフィール${profile === null ? '未保存' : '保存済み'}）`, async ({
    context,
    baseURL,
    page,
  }) => {
    await signIn(context, baseURL, 'createOrg');
    await rewriteOperation(page, onboardingStatus, (output) => ({
      ...output,
      profile,
      personal: { slug: 'setup-blocked', available: false },
    }));
    await page.goto('/auth/setup');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('利用開始を再開できません');
    await expect(page.getByText('個人用の準備ができました。', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'チームを作って招待する', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: word('onboardingReturnOrganizations') })).toBeVisible();
    expect(await findA11yViolations(page)).toEqual([]);
  });
}
