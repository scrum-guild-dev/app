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
  // 形の検査の判定はサーバー側のテスト（test/connection.test.ts）が持つ。ここは400の理由が欄の下に出て、欄が空になること。
  // 本物の登録の操作は回数の上限（10分に10回）があるので、繰り返しの実行で消費しないよう差し替える
  const calls: string[] = [];
  await routeOperation(page, connectionCreate, { slug: 'aoba' }, async (call) => {
    calls.push(call.input.credential);
    await call.fail(400, 'invalid_input', {
      details: [{ path: 'credential', code: 'credential_shape', message: 'x' }],
    });
  });
  await page.goto(`${WORKSPACE}/connections`);
  await page.getByLabel('表示名').fill('形の違う接続');
  await page.getByLabel('fine-grained personal access token').fill('not-a-token');
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'トークンの形が違います' })).toBeVisible();
  expect(calls).toEqual(['not-a-token']);
  // 認証情報の欄は送った直後に空になり、入れ直す欄にフォーカスが戻る
  const credential = page.getByLabel('fine-grained personal access token');
  await expect(credential).toHaveValue('');
  await expect(credential).toBeFocused();
  await expect(page.getByRole('list', { name: '接続の一覧' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '範囲を保存する' })).toHaveCount(0);
});

test('見えない文字だけの表示名は、送らずに理由が出る', async ({ page }) => {
  let called = 0;
  await routeOperation(page, connectionCreate, { slug: 'aoba' }, async (call) => {
    called += 1;
    await call.fail(500, 'internal');
  });
  await page.goto(`${WORKSPACE}/connections`);
  await page.getByLabel('表示名').fill('\u200b');
  await page.getByLabel('fine-grained personal access token').fill('github_pat_' + 'A'.repeat(30));
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '表示名を入れてください' })).toBeVisible();
  expect(called).toBe(0);
});

test('GitHub に届かないときは、トークンを入れ直す案内が出る', async ({ page }) => {
  await failOperation(page, connectionCreate, { slug: 'aoba' }, 503, 'unavailable');
  await page.goto(`${WORKSPACE}/connections`);
  await page.getByLabel('表示名').fill('届かない接続');
  await page.getByLabel('fine-grained personal access token').fill('github_pat_' + 'A'.repeat(30));
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'トークンを入れ直して' })).toBeVisible();
  await expect(page.getByLabel('fine-grained personal access token')).toHaveValue('');
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
    expect(call.input).toMatchObject({
      provider: 'github',
      name: 'テスト用の GitHub',
      credential: 'github_pat_' + 'A'.repeat(30),
    });
    listed = [...listed, connection];
    await call.fulfill({ connection });
  });
  await routeOperation(page, connectionScopeCandidates, { slug: 'aoba' }, async (call) => {
    expect(call.input.connection_id).toBe(NEW_ID);
    await call.fulfill({
      candidates: [
        { id: '2001', name: 'aoba/point-api' },
        { id: '2002', name: 'aoba/admin-web' },
      ],
    });
  });
  let saved: string[] = [];
  await routeOperation(page, connectionScopesSave, { slug: 'aoba' }, async (call) => {
    expect(call.input.connection_id).toBe(NEW_ID);
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
  await expect(row.locator('dd.mono').last()).toHaveText('••••末尾abcd');
});

const SEED_CONNECTION_ID = '019a0000-0000-7000-8000-000000000f01';

test('登録した本人は、範囲がまだ無い接続の行から範囲を開ける。候補を読めなければ読み直せる', async ({ page }) => {
  let attempts = 0;
  await routeOperation(page, connectionScopeCandidates, { slug: 'aoba' }, async (call) => {
    attempts += 1;
    expect(call.input.connection_id).toBe(SEED_CONNECTION_ID);
    if (attempts === 1) await call.fail(503, 'unavailable');
    else await call.fulfill({ candidates: [{ id: '2001', name: 'aoba/point-api' }] });
  });
  await page.goto(`${WORKSPACE}/connections`);
  await page.getByRole('button', { name: '範囲を選ぶ' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'GitHub に届きませんでした' })).toBeVisible();
  await page.getByRole('button', { name: '候補を読み直す' }).click();
  await expect(page.getByRole('group', { name: '取り込むリポジトリ' }).getByLabel('aoba/point-api')).toBeVisible();
  expect(attempts).toBe(2);
  // あとで選ぶで閉じると、保存せずに段が閉じる
  await page.getByRole('button', { name: 'あとで選ぶ' }).click();
  await expect(page.getByRole('button', { name: '範囲を保存する' })).toHaveCount(0);
});

test('候補を読んでいる間に別の接続を開いても、遅れて届いた候補を別の接続の下に出さない', async ({ page }) => {
  const first = created({ id: 'conn-a', name: '一つ目' });
  const second = created({ id: 'conn-b', name: '二つ目' });
  await mockOperation(page, connectionList, { slug: 'aoba' }, { connections: [first, second] });
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  await routeOperation(page, connectionScopeCandidates, { slug: 'aoba' }, async (call) => {
    if (call.input.connection_id === 'conn-a') {
      await firstGate;
      await call.fulfill({ candidates: [{ id: '1', name: 'one/from-a' }] });
    } else await call.fulfill({ candidates: [{ id: '2', name: 'two/from-b' }] });
  });
  await page.goto(`${WORKSPACE}/connections`);
  await page.locator('[data-connection-id="conn-a"]').getByRole('button', { name: '範囲を選ぶ' }).click();
  await page.locator('[data-connection-id="conn-b"]').getByRole('button', { name: '範囲を選ぶ' }).click();
  const group = page.getByRole('group', { name: '取り込むリポジトリ' });
  await expect(group.getByLabel('two/from-b')).toBeVisible();
  releaseFirst();
  // 遅れて届いた一つ目の候補は捨てられる
  await expect(page.getByText('範囲を選ぶ接続: 二つ目')).toBeVisible();
  await expect(group.getByLabel('one/from-a')).toHaveCount(0);
  await expect(group.getByLabel('two/from-b')).toBeVisible();
});

test('他の人の接続には、範囲を選ぶボタンが出ない', async ({ context, baseURL, page }) => {
  await signIn(context, baseURL, 'member');
  await page.goto(`${WORKSPACE}/connections`);
  await expect(page.getByRole('heading', { level: 1, name: '接続' })).toBeVisible();
  await expect(page.getByRole('list', { name: '接続の一覧' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '範囲を選ぶ' })).toHaveCount(0);
  // 登録の欄は、メンバーなら誰にでも出る
  await expect(page.getByRole('button', { name: '登録する' })).toBeVisible();
});
