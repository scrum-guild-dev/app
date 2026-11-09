// #1087: 画面とナビの同期。お気に入りは応答を隔離し、対象は専用ワークスペースの実データを使う。
// API の保存・権限・削除復元は favorites.test.ts が確かめる。実行は CI に任せる。
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
    await link.click();
    await expect(page).toHaveURL(new URL(item.href, baseURL).href);
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.nav-favorites')).toHaveCount(0);
    expect(reads).toBe(initialReads);
  });
}

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
  await expect(page.locator('.nav-favorites')).toHaveCount(0);
  expect(reads).toBeGreaterThan(initialReads);
  const afterDeleteReads = reads;
  const deletedToast = page.locator('.toasts:visible .toast', { hasText: `「${item.row.title}」を削除しました` });
  await deletedToast.getByRole('button', { name: '取り消す', exact: true }).click();
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
    'お気に入りは20件までです。左のメニューのお気に入りから外してから追加してください。',
  );
  await expect(section.getByRole('link')).toHaveCount(1);
});

test('閉じたワークスペースの既存の星を外し、付け直してもメニューには出さない', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const item = await target(page, baseURL, 'task');
  await create(page, baseURL, workspaceClose, { workspace_id: item.row.workspace_id });
  let marked = true;
  await routeOperation(page, favoriteList, { slug: 'aoba' }, async (call) => {
    await call.fulfill({ favorites: [], marks: marked ? listOutput([item.row]).marks : [] });
  });
  await routeOperation(page, favoriteSet, { slug: 'aoba' }, async (call) => {
    expect(call.input.target_id).toBe(item.row.target_id);
    marked = call.input.is_favorite;
    await call.fulfill({ is_favorite: marked });
  });
  await page.goto(item.initial);
  const star = page.getByRole('button', { name: 'お気に入りにする', exact: true });
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(star).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('.nav-favorites')).toHaveCount(0);
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  expect(marked).toBe(false);
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  expect(marked).toBe(true);
  await expect(page.locator('.nav-favorites')).toHaveCount(0);
  await page.reload();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.nav-favorites')).toHaveCount(0);
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
