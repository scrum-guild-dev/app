// 接続の画面（#922）。seed の受託開発チームの接続（ミナトの GitHub。読むだけ）が一覧に出ること、
// 形の違う PAT が理由つきで断られて登録されないこと、登録から範囲の選択と保存までの流れ（取り込み元に届く操作は応答を差し替える）。
// 登録の操作は本物を流さない（seed の行を増やさず、GitHub にも問い合わせない）
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';
import {
  connectionCreate,
  connectionList,
  connectionScopeCandidates,
  connectionScopesSave,
  connectionSync,
  type Connection,
} from '../src/shared/operations/connection/index.ts';

const WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';
const WORKSPACE = `/aoba/w/${WORKSPACE_ID}`;
const HIBARI_TOOLS = '/hibari/w/019a0000-0000-7000-8000-000000000402';
const MINATO = '019a0000-0000-7000-8000-000000000301';
const NEW_ID = '019a0000-0000-7000-8000-000000000f99';

test.use({ timezoneId: 'Asia/Tokyo' });
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

function created(overrides: Partial<Connection> = {}): Connection {
  return {
    id: NEW_ID,
    workspace_id: WORKSPACE_ID,
    provider: 'github',
    name: 'テスト用の GitHub',
    status: 'active',
    stopped_reason: null,
    scope_mode: 'include',
    scopes: [],
    credential_last4: 'abcd',
    owner_user_id: MINATO,
    owner_name: 'ミナト',
    last_success_at: null,
    last_error_message: null,
    last_error_at: null,
    consecutive_failures: 0,
    created_at: '2026-11-07T00:00:00.000Z',
    ...overrides,
  };
}

test('メニューの「接続」から開くと、ワークスペースの接続が状態と登録した人つきで並ぶ', async ({ page }) => {
  const collect = await watchViolations(page);
  await page.goto(WORKSPACE);
  await page.locator('.nav-item', { hasText: '接続' }).click();
  await expect(page).toHaveURL(new RegExp(`${WORKSPACE}/connections$`));
  await expect(page.getByRole('heading', { level: 1, name: '接続' })).toBeVisible();
  await expect(page).toHaveTitle('接続 - 受託開発チーム - Scrum Guild');
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('接続');

  const list = page.getByRole('list', { name: '接続の一覧' });
  const row = list.getByRole('listitem').filter({ hasText: 'ミナトの GitHub' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(row.locator('.state-badge')).toHaveText('有効');
  await expect(row.getByText('登録した人')).toBeVisible();
  await expect(row).toContainText('ミナト');
  await expect(row).toContainText('2026-10-20 10:30');
  await expect(row).toContainText('まだ選んでいません');
  // 公開範囲と組織の承認制の案内
  await expect(page.getByText('private なリポジトリのものも含めて')).toBeVisible();
  await expect(page.getByText('承認制にしていると')).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('接続が無いワークスペースでは、登録へ誘う空の表示が出る', async ({ page }) => {
  await page.goto(`${HIBARI_TOOLS}/connections`);
  await expect(page.getByRole('heading', { level: 1, name: '接続' })).toBeVisible();
  await expect(page.getByText('接続がまだありません')).toBeVisible();
  await expect(page.getByRole('list', { name: '接続の一覧' })).toHaveCount(0);
});

test('形の違うトークンは理由が出て、登録されない', async ({ page }) => {
  let registered = 0;
  // 形の検査は取り込み元に問い合わせる前に断るので、本物の API をそのまま使う
  await routeOperation(page, connectionCreate, { slug: 'aoba' }, async (call) => {
    registered += 1;
    await call.passThrough();
  });
  await page.goto(`${WORKSPACE}/connections`);
  await page.getByLabel('表示名').fill('形の違う接続');
  await page.getByLabel('fine-grained personal access token').fill('not-a-token');
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'トークンの形が違います' })).toBeVisible();
  // 認証情報の欄は送った直後に空になる
  await expect(page.getByLabel('fine-grained personal access token')).toHaveValue('');
  expect(registered).toBe(1);
  await expect(page.getByRole('list', { name: '接続の一覧' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '範囲を保存する' })).toHaveCount(0);
});

test('取り込み元が受け付けないトークンは、理由が出て、範囲の選択へ進まない', async ({ page }) => {
  await failOperation(page, connectionCreate, { slug: 'aoba' }, 400, 'invalid_input', {
    details: [{ path: 'credential', code: 'credential_rejected', message: 'x' }],
  });
  await page.goto(`${WORKSPACE}/connections`);
  await page.getByLabel('表示名').fill('受け付けられない接続');
  await page.getByLabel('fine-grained personal access token').fill('github_pat_' + 'A'.repeat(30));
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'GitHub がこのトークンを受け付けませんでした' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '範囲を保存する' })).toHaveCount(0);
});

test('登録すると同じ画面で範囲の候補が出て、選んで保存できる', async ({ page }) => {
  const connection = created();
  let listed = [created({ id: 'seed', name: 'ミナトの GitHub' })];
  await routeOperation(page, connectionList, { slug: 'aoba' }, (call) => call.fulfill({ connections: listed }));
  await routeOperation(page, connectionCreate, { slug: 'aoba' }, async (call) => {
    expect(call.input).toMatchObject({ provider: 'github', name: 'テスト用の GitHub' });
    listed = [...listed, connection];
    await call.fulfill({ connection });
  });
  await mockOperation(
    page,
    connectionScopeCandidates,
    { slug: 'aoba' },
    {
      candidates: [
        { id: '2001', name: 'aoba/point-api' },
        { id: '2002', name: 'aoba/admin-web' },
      ],
    },
  );
  let saved: string[] = [];
  await routeOperation(page, connectionScopesSave, { slug: 'aoba' }, async (call) => {
    saved = call.input.source_ids;
    const scopes = [{ id: '2002', name: 'aoba/admin-web' }];
    listed = listed.map((item) => (item.id === NEW_ID ? { ...item, scopes } : item));
    await call.fulfill({ connection: { ...connection, scopes } });
  });

  await page.goto(`${WORKSPACE}/connections`);
  await page.getByLabel('表示名').fill('テスト用の GitHub');
  await page.getByLabel('fine-grained personal access token').fill('github_pat_' + 'A'.repeat(30));
  await page.getByRole('button', { name: '登録する' }).click();

  const group = page.getByRole('group', { name: '取り込むリポジトリ' });
  await expect(group.getByLabel('aoba/point-api')).not.toBeChecked();
  await group.getByLabel('aoba/admin-web').check();
  await expect(page.getByText('1 件を選んでいます')).toBeVisible();
  await page.getByRole('button', { name: '範囲を保存する' }).click();

  await expect(page.getByRole('button', { name: '範囲を保存する' })).toHaveCount(0);
  expect(saved).toEqual(['2002']);
  const row = page
    .getByRole('list', { name: '接続の一覧' })
    .getByRole('listitem')
    .filter({ hasText: 'テスト用の GitHub' });
  await expect(row.locator('.tag')).toHaveText('aoba/admin-web');
  await expect(row).toContainText('••••abcd');
});

test('今すぐ同期は本人の接続にだけ出て、押すと届いた件数がトーストに出る。5分以内の再押しは断りが出る', async ({
  page,
}) => {
  const scopes = [{ id: '2001', name: 'aoba/point-api' }];
  const mine = created({ id: 'mine', name: 'ミナトの GitHub', scopes });
  const others = created({
    id: 'others',
    name: 'ハルカの GitHub',
    scopes,
    owner_user_id: 'other',
    owner_name: 'ハルカ',
  });
  const stopped = created({
    id: 'stopped',
    name: '止まった GitHub',
    scopes,
    status: 'stopped',
    stopped_reason: 'auth_failed',
  });
  await routeOperation(page, connectionList, { slug: 'aoba' }, (call) =>
    call.fulfill({ connections: [mine, others, stopped] }),
  );
  let calls = 0;
  await routeOperation(page, connectionSync, { slug: 'aoba' }, async (call) => {
    calls++;
    expect(call.input.connection_id).toBe('mine');
    if (calls === 1) await call.fulfill({ result: 'success', imported: 3, more: false, connection: mine });
    else await call.fail(429, 'rate_limited');
  });

  await page.goto(`${WORKSPACE}/connections`);
  const list = page.getByRole('list', { name: '接続の一覧' });
  await expect(list.getByRole('button', { name: '今すぐ同期' })).toHaveCount(1);
  await expect(list.getByRole('listitem').filter({ hasText: 'ハルカの GitHub' })).not.toContainText('今すぐ同期');
  await expect(list.getByRole('listitem').filter({ hasText: '止まった GitHub' })).not.toContainText('今すぐ同期');
  await expect(list.getByRole('listitem').filter({ hasText: '止まった GitHub' })).toContainText(
    '認証情報を受け付けなかったため',
  );

  await list.getByRole('button', { name: '今すぐ同期' }).click();
  await expect(page.getByRole('status').filter({ hasText: '3 件届きました' })).toBeVisible();
  await list.getByRole('button', { name: '今すぐ同期' }).click();
  await expect(page.getByRole('status').filter({ hasText: '5分に1回までです' })).toBeVisible();
  expect(calls).toBe(2);
});
