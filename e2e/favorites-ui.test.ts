// #1087: 画面とナビの同期。対象は専用ワークスペースの実データを使う。
// 各画面と失敗時は応答を隔離し、末尾の往復・閉鎖ケースはお気に入りの実 API を通す。実行は CI に任せる。
import type { Page } from '@playwright/test';
import { operationPath, type AnyOperationDefinition, type OutputOf } from '../src/shared/operations/define.ts';
import { favoriteList, favoriteSet } from '../src/shared/operations/favorite.ts';
import { taskCreate, taskDelete, taskRestore } from '../src/shared/operations/task/index.ts';
import { storyCreate } from '../src/shared/operations/story/index.ts';
import { epicCreate } from '../src/shared/operations/epic/index.ts';
import { orgWikiCreate, workspaceWikiCreate } from '../src/shared/operations/wiki/index.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { workspaceClose } from '../src/shared/operations/workspace/workspace-close.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { failOperation, routeOperation } from './operations.ts';

type Favorite = OutputOf<typeof favoriteList>['favorites'][number];
type Kind = 'task' | 'task-drawer' | 'story' | 'epic' | 'org-wiki' | 'workspace-wiki';

function listOutput(rows: Favorite[]): OutputOf<typeof favoriteList> {
  return {
    favorites: rows,
    marks: rows.map(({ target_type, target_id }) => ({ target_type, target_id })),
  };
}

async function create<D extends AnyOperationDefinition>(
  page: Page,
  baseURL: string,
  definition: D,
  input: unknown,
): Promise<OutputOf<D>> {
  const response = await page.request.post(operationPath(definition, 'aoba'), {
    headers: { Origin: new URL(baseURL).origin },
    data: definition.input.parse(input),
  });
  expect(response.status()).toBe(200);
  return definition.output.parse(await response.json()) as OutputOf<D>;
}

async function target(page: Page, baseURL: string, kind: Kind) {
  const title = `お気に入りの確認-${kind}-${crypto.randomUUID().slice(0, 8)}`;
  const { workspace_id } = await create(page, baseURL, workspaceCreate, {
    name: title,
    timezone: 'Asia/Tokyo',
    leader_user_id: '019a0000-0000-7000-8000-000000000301',
  });
  const root = `/aoba/w/${workspace_id}`;
  let type: Favorite['target_type'];
  let id: string;
  let href: string;
  if (kind === 'task' || kind === 'task-drawer') {
    type = 'task';
    id = (await create(page, baseURL, taskCreate, { workspace_id, title })).task.id;
    href = `${root}/tasks/${id}`;
  } else if (kind === 'story') {
    type = 'story';
    id = (await create(page, baseURL, storyCreate, { workspace_id, title })).story.id;
    href = `${root}?story=${id}`;
  } else if (kind === 'epic') {
    type = 'epic';
    id = (await create(page, baseURL, epicCreate, { workspace_id, title })).epic.id;
    href = `${root}/epics/${id}`;
  } else {
    type = 'wiki_page';
    id =
      kind === 'org-wiki'
        ? (await create(page, baseURL, orgWikiCreate, { title, body_md: 'よく読む手順です。' })).page.id
        : (await create(page, baseURL, workspaceWikiCreate, { workspace_id, title, body_md: 'よく読む手順です。' }))
            .page.id;
    href = `${kind === 'org-wiki' ? '/aoba' : root}/wiki/${id}`;
  }
  return {
    initial: kind === 'task-drawer' ? `${root}?task=${id}` : href,
    href,
    row: {
      id: crypto.randomUUID(),
      target_type: type,
      target_id: id,
      workspace_id: kind === 'org-wiki' ? null : workspace_id,
      title,
      created_at: new Date().toISOString(),
    } satisfies Favorite,
  };
}

for (const kind of ['task', 'task-drawer', 'story', 'epic', 'org-wiki', 'workspace-wiki'] as const) {
  test(`${kind}: 星を付けるとナビに現れ、そこから開いて外すと節が消える`, async ({ page, context, baseURL }) => {
    if (!baseURL) throw new Error('baseURL が無い');
    await signIn(context, baseURL, 'admin');
    const item = await target(page, baseURL, kind);
    let rows: Favorite[] = [];
    let reads = 0;
    await routeOperation(page, favoriteList, { slug: 'aoba' }, async (call) => {
      reads++;
      await call.fulfill(listOutput(rows));
    });
    await routeOperation(page, favoriteSet, { slug: 'aoba' }, async (call) => {
      expect(call.input.target_type).toBe(item.row.target_type);
      expect(call.input.target_id).toBe(item.row.target_id);
      rows = call.input.is_favorite ? [item.row] : [];
      await call.fulfill({ is_favorite: call.input.is_favorite });
    });
    await page.goto(item.initial);
    const star = page.getByRole('button', { name: 'お気に入りにする', exact: true });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.nav-favorites')).toHaveCount(0);
    const initialReads = reads;
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    expect(reads).toBe(initialReads);
    // 引き出しでは外側のナビが inert。閉じてから項目を押す。
    if (kind === 'task-drawer' || kind === 'story') {
      await page
        .getByRole('dialog', { name: item.row.title, exact: true })
        .getByRole('button', { name: '閉じる', exact: true })
        .click();
    }
    const link = page.locator('.nav-favorites').getByRole('link', { name: item.row.title, exact: true });
    await expect(link).toHaveAttribute('href', item.href);
    await expect(link).toHaveAttribute('title', item.row.title);
    // 今と同じ URL を押す再読み込みでなく、別画面からお気に入りの行き先へ戻れることを確かめる。
    await page.getByRole('link', { name: '今日やること', exact: true }).click();
    await expect(page).toHaveURL(new URL('/aoba', baseURL).href);
    await link.click();
    await expect(page).toHaveURL(new URL(item.href, baseURL).href);
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    const readsBeforeRemove = reads;
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.nav-favorites')).toHaveCount(0);
    expect(reads).toBe(readsBeforeRemove);
  });
}

// #1114: OS 自動選択も含め、実際に描かれる星の金色と塗りを確認する。
test('お気に入りの星は全テーマで金色に塗られ、外すと輪郭に戻る', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const item = await target(page, baseURL, 'task');
  await routeOperation(page, favoriteList, { slug: 'aoba' }, async (call) => {
    await call.fulfill(listOutput([]));
  });
  await routeOperation(page, favoriteSet, { slug: 'aoba' }, async (call) => {
    await call.fulfill({ is_favorite: call.input.is_favorite });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(item.initial);
  const star = page.getByRole('button', { name: 'お気に入りにする', exact: true });
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  for (const [theme, scheme, color] of [
    ['simple', 'light', 'rgb(153, 112, 0)'],
    ['simple_light', 'dark', 'rgb(153, 112, 0)'],
    ['simple', 'dark', 'rgb(245, 204, 69)'],
    ['simple_dark', 'light', 'rgb(245, 204, 69)'],
    ['modern', 'light', 'rgb(245, 204, 69)'],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(star).toHaveCSS('color', color);
    await expect(star.locator('svg')).toHaveCSS('fill', color);
    await star.hover();
    await expect(star).toHaveCSS('color', color);
  }
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await expect(star.locator('svg')).toHaveCSS('fill', 'none');
});

test('お気に入りのタスクを削除するとナビから消え、取り消すと戻る', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const item = await target(page, baseURL, 'task-drawer');
  let rows: Favorite[] = [item.row];
  let reads = 0;
  await routeOperation(page, favoriteList, { slug: 'aoba' }, async (call) => {
    reads++;
    await call.fulfill(listOutput(rows));
  });
  await routeOperation(page, taskDelete, { slug: 'aoba' }, async (call) => {
    const result = await call.fetch();
    rows = [];
    await call.fulfill(result);
  });
  await routeOperation(page, taskRestore, { slug: 'aoba' }, async (call) => {
    const result = await call.fetch();
    rows = [item.row];
    await call.fulfill(result);
  });
  await page.goto(item.initial);
  const drawer = page.getByRole('dialog', { name: item.row.title, exact: true });
  await expect(drawer.getByRole('button', { name: 'お気に入りにする', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const initialReads = reads;
  await drawer.getByRole('button', { name: 'このタスクを削除する', exact: true }).click();
  await expect(drawer).toBeHidden();
  const deletedToast = page.locator('.toasts:visible .toast', { hasText: `「${item.row.title}」を削除しました` });
  const undo = deletedToast.getByRole('button', { name: '取り消す' });
  // 一覧の再取得を待つ間にトーストの表示時間が尽きないよう、取り消すへフォーカスを置く。
  await undo.focus();
  await expect(page.locator('.nav-favorites')).toHaveCount(0);
  expect(reads).toBeGreaterThan(initialReads);
  const afterDeleteReads = reads;
  await undo.click();
  await expect(page.locator('.nav-favorites').getByRole('link', { name: item.row.title, exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(afterDeleteReads);
});

test('畳んだメニューでは節を隠し、上限の拒否は星の近くで20件と次の手を伝える', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const item = await target(page, baseURL, 'task');
  await routeOperation(page, favoriteList, { slug: 'aoba' }, async (call) => {
    await call.fulfill(listOutput([{ ...item.row, target_id: crypto.randomUUID(), title: '既存のお気に入り' }]));
  });
  await failOperation(page, favoriteSet, { slug: 'aoba' }, 409, 'favorite_limit', { details: { used: 20, limit: 20 } });
  await page.goto(item.initial);
  const section = page.locator('.nav-favorites');
  await expect(section).toBeVisible();
  await page.getByRole('button', { name: 'メニューを畳む', exact: true }).click();
  await expect(section).toBeHidden();
  await page.getByRole('button', { name: 'メニューを広げる', exact: true }).click();
  await expect(section).toBeVisible();
  const star = page.getByRole('button', { name: 'お気に入りにする', exact: true });
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('alert')).toContainText(
    'お気に入りは20件までです。登録した対象の星を外してから追加してください。',
  );
  await expect(section.getByRole('link')).toHaveCount(1);
});

test('実APIで星を付けてナビから開き、閉じたワークスペースでも印を外して付け直せる', async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const item = await target(page, baseURL, 'task');
  const ownMark = { target_type: item.row.target_type, target_id: item.row.target_id };
  try {
    await page.goto(item.initial);
    const star = page.getByRole('button', { name: 'お気に入りにする', exact: true });
    const link = page.locator('.nav-favorites').getByRole('link', { name: item.row.title, exact: true });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(link).toBeVisible();
    await page.getByRole('link', { name: '今日やること', exact: true }).click();
    await expect(page).toHaveURL(new URL('/aoba', baseURL).href);
    await link.click();
    await expect(page).toHaveURL(new URL(item.href, baseURL).href);
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await create(page, baseURL, workspaceClose, { workspace_id: item.row.workspace_id });
    // request fixture による外部の変更は画面への通知を通らないため、明示的に読み直す。
    await page.reload();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(star).toHaveAttribute('aria-disabled', 'false');
    await expect(link).toHaveCount(0);
    const closedList = await create(page, baseURL, favoriteList, {});
    expect(closedList.marks).toContainEqual(ownMark);
    expect(closedList.favorites.some((row) => row.target_id === item.row.target_id)).toBe(false);
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    expect((await create(page, baseURL, favoriteList, {})).marks).not.toContainEqual(ownMark);
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(link).toHaveCount(0);
    await page.reload();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(link).toHaveCount(0);
  } finally {
    // 実際に保存した本人の印は、失敗時にも外し、繰り返し実行で20件を消費しない。
    await create(page, baseURL, favoriteSet, { ...ownMark, is_favorite: false });
  }
});

test('一覧の読み込み失敗を星の近くに示し、再試行すると既存の印が戻る', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const item = await target(page, baseURL, 'task');
  let reads = 0;
  await routeOperation(page, favoriteList, { slug: 'aoba' }, async (call) => {
    reads++;
    if (reads === 1) await call.fail(500, 'internal');
    else await call.fulfill(listOutput([item.row]));
  });
  await page.goto(item.initial);
  const star = page.getByRole('button', { name: 'お気に入りにする', exact: true });
  await expect(star).toHaveAttribute('aria-disabled', 'true');
  const control = page.locator('.favorite-control');
  await expect(control).toContainText('お気に入りを読み込めませんでした。');
  await expect(star).toHaveAttribute('aria-describedby', /.+/);
  await control.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(star).toHaveAttribute('aria-disabled', 'false');
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(control).not.toContainText('お気に入りを読み込めませんでした。');
  await expect(page.locator('.nav-favorites').getByRole('link', { name: item.row.title, exact: true })).toBeVisible();
  expect(reads).toBe(2);
});

test('取得済みの一覧の更新に失敗しても再試行のボタンを保ち、失敗はその場、成功は星へフォーカスする', async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const item = await target(page, baseURL, 'task');
  let reads = 0;
  let releaseFailure!: () => void;
  let releaseSuccess!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const successGate = new Promise<void>((resolve) => {
    releaseSuccess = resolve;
  });
  await routeOperation(page, favoriteList, { slug: 'aoba' }, async (call) => {
    reads++;
    if (reads === 1) await call.fulfill(listOutput([]));
    else if (reads === 2) await call.fail(500, 'internal');
    else if (reads === 3) {
      await failureGate;
      await call.fail(500, 'internal');
    } else {
      await successGate;
      await call.fulfill(listOutput([]));
    }
  });
  await failOperation(page, favoriteSet, { slug: 'aoba' }, 409, 'favorite_limit', { details: { used: 20, limit: 20 } });
  try {
    await page.goto(item.initial);
    const control = page.locator('.favorite-control');
    const star = control.getByRole('button', { name: 'お気に入りにする', exact: true });
    await expect(star).toHaveAttribute('aria-disabled', 'false');
    // 実際のタイトル保存の通知で一覧だけを更新し、その更新を失敗させる。
    await page.locator('.drawer-title').getByRole('button').click();
    const title = page.getByRole('textbox', { name: 'タイトル', exact: true });
    await title.fill(`${item.row.title}-改訂`);
    await title.press('Enter');
    await expect(control).toContainText('お気に入りを読み込めませんでした。');
    await expect(star).toHaveAttribute('aria-disabled', 'false');
    await star.click();
    // 一覧更新の失敗と、星の操作で断られた理由を両方読むことができる。
    await expect(control.getByRole('alert')).toContainText(
      'お気に入りは20件までです。登録した対象の星を外してから追加してください。',
    );
    const retry = control.getByRole('button', { name: 'もう一度試す', exact: true });
    const originalRetry = await retry.elementHandle();
    await retry.focus();
    await retry.click();
    await expect.poll(() => reads).toBe(3);
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(retry).toBeFocused();
    expect(await originalRetry!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(control.getByRole('status')).toHaveText('読み込んでいます');
    releaseFailure();
    await expect(retry).toHaveAttribute('aria-disabled', 'false');
    await expect(retry).toBeFocused();
    await expect(control.getByRole('status')).toHaveText('まだ読み込めませんでした');
    await retry.click();
    await expect.poll(() => reads).toBe(4);
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(retry).toBeFocused();
    expect(await originalRetry!.evaluate((element) => element.isConnected)).toBe(true);
    releaseSuccess();
    await expect(retry).toHaveCount(0);
    await expect(star).toBeFocused();
    await expect(control).not.toContainText('お気に入りを読み込めませんでした。');
  } finally {
    releaseFailure();
    releaseSuccess();
  }
});
