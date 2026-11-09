// #1101: お気に入りの一覧の画面。一覧は応答を差し替えて決め、並び、行き先、空、読み込みの失敗を確かめる。
// axe、44px、狭い幅のはみ出しは e2e/a11y-screen-fixtures.ts の favorites で確かめる
import type { OutputOf } from '../src/shared/operations/define.ts';
import { favoriteList } from '../src/shared/operations/favorite.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { failOperation, mockOperation, routeOperation } from './operations.ts';

type Favorite = OutputOf<typeof favoriteList>['favorites'][number];

const WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

function row(index: number, target_type: Favorite['target_type'], title: string, workspace: boolean): Favorite {
  return {
    id: `019a0000-0000-7000-8000-00000000e0${index}0`,
    target_type,
    target_id: `019a0000-0000-7000-8000-00000000e0${index}1`,
    workspace_id: workspace ? WORKSPACE_ID : null,
    title,
    created_at: '2026-11-10T00:00:00.000Z',
  };
}

// 返す順のとおりに並ぶことを確かめるため、id は返す順と逆にし、種類も決まった順にしない（画面が並べ替えると落ちる）
const ROWS: Favorite[] = [
  row(4, 'task', '朝会の進め方をまとめる', true),
  row(3, 'story', '招待から最初のタスクまで迷わず進める', true),
  row(2, 'epic', '初めて使う人が仕事を始められるようにする', true),
  row(1, 'wiki_page', 'ふくろう班の開発手順', false),
];

test('付けた対象が返った順に、種類と一緒に並び、押すとその対象へ移る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, favoriteList, { slug: 'aoba' }, { favorites: ROWS, marks: [] });
  await page.goto('/aoba/favorites');

  await expect(page).toHaveTitle(/^お気に入り/);
  await expect(page.getByRole('heading', { level: 1, name: 'お気に入り' })).toBeVisible();
  const links = page.getByRole('main').getByRole('link');
  await expect(links).toHaveText([
    /朝会の進め方をまとめる\s*タスク/,
    /招待から最初のタスクまで迷わず進める\s*ストーリー/,
    /初めて使う人が仕事を始められるようにする\s*エピック/,
    /ふくろう班の開発手順\s*Wiki のページ/,
  ]);
  const root = `/aoba/w/${WORKSPACE_ID}`;
  await expect(links.nth(0)).toHaveAttribute('href', `${root}/tasks/${ROWS[0]!.target_id}`);
  await expect(links.nth(1)).toHaveAttribute('href', `${root}?story=${ROWS[1]!.target_id}`);
  await expect(links.nth(2)).toHaveAttribute('href', `${root}/epics/${ROWS[2]!.target_id}`);
  await expect(links.nth(3)).toHaveAttribute('href', `/aoba/wiki/${ROWS[3]!.target_id}`);

  await links.nth(3).click();
  await expect(page).toHaveURL(new RegExp(`/aoba/wiki/${ROWS[3]!.target_id}$`));
});

test('お気に入りが無いときは、どこで星を付けるかを出す', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, favoriteList, { slug: 'aoba' }, { favorites: [], marks: [] });
  await page.goto('/aoba/favorites');

  await expect(page.getByText('お気に入りはまだありません')).toBeVisible();
  await expect(
    page.getByText('タスク、ストーリー、エピック、Wiki のページの星を押すと、ここに並びます。'),
  ).toBeVisible();
});

test('一覧を読めないときは理由を出し、もう一度試すと並ぶ', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  const unroute = await failOperation(page, favoriteList, { slug: 'aoba' }, 500, 'internal');
  await page.goto('/aoba/favorites');

  const main = page.getByRole('main');
  await expect(main.getByText('お気に入りを読み込めませんでした。')).toBeVisible();
  await expect(main.getByText('お気に入りはまだありません')).toHaveCount(0);

  await unroute();
  await routeOperation(page, favoriteList, { slug: 'aoba' }, (call) => call.fulfill({ favorites: ROWS, marks: [] }));
  await main.getByRole('button', { name: 'もう一度試す' }).click();
  // 案内ごとボタンが消えるので、フォーカスは最初の行へ移る（body に落とさない）
  await expect(main.getByRole('link', { name: /朝会の進め方をまとめる/ })).toBeFocused();
  await expect(main.getByText('お気に入りを読み込めませんでした。')).toHaveCount(0);
});

test('390px の幅でも行の高さが 44px 以上ある', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOperation(page, favoriteList, { slug: 'aoba' }, { favorites: ROWS, marks: [] });
  await page.goto('/aoba/favorites');

  const links = page.getByRole('main').getByRole('link');
  await expect(links).toHaveCount(ROWS.length);
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
