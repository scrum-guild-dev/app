// 失敗のトースト（左の縦線、成功より長く出る）と、URL を直接開いた最初の読み込みの表示（#boot-loading）を確かめる（#1004）。
// 失敗は今日やることの印の付け外しを 404 で断られて作る。seed のセッション（seed/sessions.ts）の Cookie で開く。
// 一般のユーザーはハルカ（あおば開発の受託開発チーム）、管理者はミナト。応答を差し替えるだけで、seed の行は書き換えない
import { today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { backlogTree, taskTodayMark } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

const row: TodayTask = {
  id: '消えた行',
  title: '消えた行',
  points: null,
  due_on: '2026-11-06',
  today_on: null,
  completed_at: null,
  workspace_id: '019a0000-0000-7000-8000-000000000401',
  workspace_name: '受託開発チーム',
  today: '2026-11-04',
  week_start: 1,
  position: 'a0',
  carry_days: 0,
  sprint_active: false,
  is_today_completed: false,
  reopenable: false,
  assignee: null,
  repository: null,
  sprint: null,
};

test('失敗のトーストは左に縦線が付き、成功の倍の 8 秒ほど出て、消えるときは抜ける動きが再生される', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'member');
  await page.clock.install();
  // Svelte の out は Element.animate で動く。{#each} の項目の削除でも再生される（out:…|global）ことを、呼び出しの記録で確かめる
  await page.addInitScript(() => {
    const played: { opacity: unknown }[] = [];
    (window as unknown as { __played: typeof played }).__played = played;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList.contains('toast-leaving') && Array.isArray(keyframes)) {
        for (const frame of keyframes) played.push({ opacity: (frame as Keyframe).opacity });
      }
      return animate.call(this, keyframes, options);
    };
  });
  await routeOperation(page, today, { slug: 'aoba' }, (call) =>
    call.fulfill({ tasks: [{ ...row }], sprint_goals: [] }),
  );
  await routeOperation(page, taskTodayMark, { slug: 'aoba' }, (call) => call.fail(404, 'not_found'));
  await page.goto('/aoba');

  await page.getByRole('button', { name: '今日やる: 消えた行' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'このタスクは見つかりません' });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveClass(/is-failure/);
  // 左の縦線は 4px の実線。成功のトーストには付かない
  await expect(toast).toHaveCSS('border-inline-start-width', '4px');

  // 4 秒（成功の長さ）では消えない。8 秒で消える
  await page.clock.runFor(4_500);
  await expect(toast).toBeVisible();
  await page.clock.runFor(3_700);
  await expect(toast).toHaveCount(0);
  // 退場の再生は、消す時間切れの直後の描画の中で始まる。記録が付くのを待つ
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __played: unknown[] }).__played.length))
    .toBeGreaterThan(0);
});

test('URL を直接開いて木の読み込みが遅いとき、300ms 後に読み込み中の表示が出て、描けたら消える', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.passThrough();
  });
  await page.goto(WORKSPACE, { waitUntil: 'commit' });

  const boot = page.locator('#boot-loading');
  await expect(boot).toBeVisible();
  await expect(boot.locator('.boot-wait')).toHaveText('読み込んでいます');
  // 行き先が組織の枠なので、紙ではなく枠の形の骨組みを出す。左のメニューの幅と上の帯の高さは描いた後と同じ
  await expect(boot.locator('.boot-frame')).toBeVisible();
  await expect(boot.locator('.boot-skeleton')).toBeHidden();
  const bootBinding = await boot.locator('.boot-binding').boundingBox();
  const bootTopbar = await boot.locator('.boot-topbar').boundingBox();

  release();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(boot).toHaveCount(0);
  const binding = await page.locator('.binding').boundingBox();
  const topbar = await page.locator('.topbar').boundingBox();
  expect(bootBinding?.width).toBe(binding?.width);
  expect(bootTopbar?.x).toBe(topbar?.x);
  expect(bootTopbar?.height).toBe(topbar?.height);
});

test('15 秒たっても描けないときは、読み込み中の文を失敗の文と再読み込みのリンクに替える', async ({
  page,
  context,
  baseURL,
}) => {
  // CSS の animation-delay は page.clock では進まないので、実時間で 15 秒待つ
  test.setTimeout(60_000);
  await signIn(context, baseURL, 'admin');
  // 木が返らない（描けない）まま 15 秒たたせる
  await routeOperation(page, backlogTree, { slug: 'aoba' }, () => new Promise<void>(() => {}));
  await page.goto(WORKSPACE, { waitUntil: 'commit' });

  const boot = page.locator('#boot-loading');
  await expect(boot.getByText('読み込んでいます')).toBeVisible();
  await expect(boot.getByText('読み込めませんでした')).toBeHidden();
  await expect(boot.getByText('読み込めませんでした')).toBeVisible({ timeout: 20_000 });
  await expect(boot.getByText('読み込んでいます')).toBeHidden();
  await expect(boot.locator('.boot-frame')).toBeHidden();
  await expect(boot.getByRole('link', { name: 'もう一度試す' })).toBeVisible();
});
