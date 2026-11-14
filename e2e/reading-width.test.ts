// 広い画面の今日やることの台帳と空の状態の幅と、左のメニュー、節の見出しの行の仕上げ（#1182）。
// 本文（.content）は幅の上限を持たず（#708）、横に伸びると読みにくい部品が自分で幅を持つ。台帳（.book）と空の状態（.empty）は 1200px で止まる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。一般のユーザーはハルカ（あおば開発の受託開発チームに所属）
import { today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { mockOperation } from './operations.ts';

const WORKSPACE = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };
const READING_MAX = 1200;
const TODAY = '2026-11-04';

function marked(id: string): TodayTask {
  return {
    id,
    title: id,
    points: null,
    due_on: null,
    today_on: TODAY,
    completed_at: null,
    workspace_id: WORKSPACE.id,
    workspace_name: WORKSPACE.name,
    today: TODAY,
    week_start: 1,
    position: 'a0',
    carry_days: 0,
    sprint_active: false,
    is_today_completed: false,
    reopenable: false,
    assignee: null,
    delegatee: null,
    repository: null,
    sprint: null,
  };
}

test.use({ viewport: { width: 2000, height: 1000 } });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'member');
});

for (const state of [
  { name: '行がある', tasks: [marked('今日やる行')], part: '.book' },
  { name: '空の', tasks: [], part: '.empty' },
]) {
  test(`幅 2000px の今日やることで、${state.name}台帳は ${READING_MAX}px で止まり、見出しは画面の幅まで広がる`, async ({
    page,
  }) => {
    await mockOperation(page, today, { slug: 'aoba' }, { tasks: state.tasks, sprint_goals: [] });
    await page.goto('/aoba');
    const section = page.getByRole('region', { name: '今日やると決めたもの', exact: true });
    const part = section.locator(state.part);
    await expect(part).toBeVisible();
    const head = (await page.locator('.page-head').boundingBox())!;
    const box = (await part.boundingBox())!;
    // 本文は上限を持たないので、見出しは 1200px を超えて広がる（止まっていたら、部品の上限を確かめたことにならない）
    expect(head.width).toBeGreaterThan(READING_MAX);
    expect(box.width).toBeLessThanOrEqual(READING_MAX);
    expect(Math.round(box.x)).toBe(Math.round(head.x));
  });
}

test('節の補足は見出しの行の右端へ離れず、件数のすぐ後ろに出る', async ({ page }) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: [marked('今日やる行')], sprint_goals: [] });
  await page.goto('/aoba');
  const section = page.getByRole('region', { name: '今日やると決めたもの', exact: true });
  const count = section.locator('.section-count');
  const hint = section.locator('.section-hint');
  await expect(count).toHaveText('1 件');
  await expect(hint).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // 書体の読み込みで幅が変わるので、同じ描画時点の座標をまとめて取る。
  const { countBox, hintBox } = await section.evaluate((element) => ({
    countBox: element.querySelector('.section-count')!.getBoundingClientRect().toJSON(),
    hintBox: element.querySelector('.section-hint')!.getBoundingClientRect().toJSON(),
  }));
  // 件数と補足の間は見出しの行の間（12px）だけで、同じ行に並ぶ
  expect(hintBox.x - (countBox.x + countBox.width)).toBeLessThanOrEqual(16);
  expect(Math.abs(hintBox.y + hintBox.height - (countBox.y + countBox.height))).toBeLessThanOrEqual(4);
});

test('左のメニューの「ワークスペース」は見出しの1回だけ見え、切り替えのボタンの名前には残る', async ({ page }) => {
  await page.goto(`/aoba/w/${WORKSPACE.id}`);
  const nav = page.locator('#app-nav');
  await expect(nav.locator('.ws-menu-button')).toBeVisible();
  await expect(nav.getByText('ワークスペース', { exact: true })).toHaveCount(1);
  await expect(nav.locator('.nav-group-label', { hasText: 'ワークスペース' })).toBeVisible();
  await expect(nav.locator('.ws-menu-button')).toHaveAccessibleName(/ワークスペース/);
});

test('選択中のメニューとパンくずの今の画面は太さ 600、群の見出しは字間を広げない', async ({ page }) => {
  await page.goto(`/aoba/w/${WORKSPACE.id}`);
  await expect(page.locator('.tree-row').first()).toBeVisible();
  await expect(page.locator('#app-nav .nav-item[aria-current="page"]')).toHaveCSS('font-weight', '600');
  await expect(page.locator('.breadcrumb-item[aria-current="page"]')).toHaveCSS('font-weight', '600');
  const group = page.locator('#app-nav .nav-group').first();
  const spacing = await group.evaluate((element) => {
    const style = getComputedStyle(element);
    return parseFloat(style.letterSpacing) / parseFloat(style.fontSize);
  });
  expect(spacing).toBeCloseTo(0.04, 2);
});
