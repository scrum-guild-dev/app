// 広い画面の読む画面（今日やること、マイプロフィール、エピックの詳細）の幅と、左のメニュー、節の見出しの行の仕上げ（#1182）。
// 読む画面は見出しと本文を 1200px で止め、バックログは画面の幅まで広げる。
// seed のセッション（seed/sessions.ts）の Cookie で開く。一般のユーザーはハルカ（あおば開発の受託開発チームに所属）
import type { Page } from '@playwright/test';
import { today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { mockOperation } from './operations.ts';

const WORKSPACE = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
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

// 本文の直下の子の幅の最大と、左端がそろっているか。available は、本文の枠を止めなかったときに使えた幅
// （枠の親の幅から枠の左右の余白を引いたもの。読む画面は枠ごと止めるので、枠の幅では測れない）
async function contentChildren(page: Page): Promise<{ widest: number; lefts: number[]; available: number }> {
  return page.evaluate(() => {
    const content = document.querySelector('main.content')!;
    const style = getComputedStyle(content);
    const available =
      content.parentElement!.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const boxes = [...content.children]
      .filter((child) => child instanceof HTMLElement && child.offsetParent !== null)
      .map((child) => child.getBoundingClientRect())
      // 読み上げだけの見えない要素（1px 四方）は並びに数えない
      .filter((box) => box.width > 1);
    return {
      widest: Math.max(...boxes.map((box) => box.width)),
      lefts: [...new Set(boxes.map((box) => Math.round(box.left)))],
      available,
    };
  });
}

for (const screen of [
  { name: '今日やること', path: '/aoba', ready: (page: Page) => page.locator('.section').first() },
  { name: 'マイプロフィール', path: '/aoba/me', ready: (page: Page) => page.locator('.layout-aside') },
  {
    name: 'エピックの詳細',
    path: `/aoba/w/${WORKSPACE.id}/epics/${EPIC_ID}`,
    ready: (page: Page) => page.locator('.layout-aside'),
  },
]) {
  test(`幅 2000px の${screen.name}は、見出しと本文が左寄せで ${READING_MAX}px に収まる`, async ({ page }) => {
    await page.goto(screen.path);
    await expect(page.locator('.page-head.is-reading')).toBeVisible();
    await expect(screen.ready(page)).toBeVisible();
    const measured = await contentChildren(page);
    // 止めないと 1200px を超える幅で測っていることを先に確かめる
    expect(measured.available).toBeGreaterThan(READING_MAX);
    expect(measured.widest).toBeLessThanOrEqual(READING_MAX);
    expect(measured.lefts).toHaveLength(1);
  });
}

test.describe('読む画面で開く引き出し', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('幅 2000px のエピックの詳細で引き出しを開くと、幕は読む幅で止まらず画面全体を覆う', async ({ page }) => {
    await page.goto(`/aoba/w/${WORKSPACE.id}/epics/${EPIC_ID}`);
    await expect(page.locator('.page-head.is-reading')).toBeVisible();
    await page.getByRole('link', { name: 'エピックを直す' }).click();
    const scrim = page.locator('.scrim');
    await expect(scrim).toBeVisible();
    const box = (await scrim.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(2000);
  });
});

test(`幅 2000px のバックログは、読む画面の幅で止めず画面の幅まで広がる`, async ({ page }) => {
  await page.goto(`/aoba/w/${WORKSPACE.id}`);
  await expect(page.locator('.tree-row').first()).toBeVisible();
  await expect(page.locator('.page-head.is-reading')).toHaveCount(0);
  const measured = await contentChildren(page);
  expect(measured.widest).toBeGreaterThan(READING_MAX);
  expect(Math.round(measured.widest)).toBe(Math.round(measured.available));
});

test('節の補足は見出しの行の右端へ離れず、件数のすぐ後ろに出る', async ({ page }) => {
  await mockOperation(page, today, { slug: 'aoba' }, { tasks: [marked('今日やる行')], sprint_goals: [] });
  await page.goto('/aoba');
  const section = page.getByRole('region', { name: '今日やると決めたもの', exact: true });
  const count = section.locator('.section-count');
  const hint = section.locator('.section-hint');
  await expect(count).toHaveText('1 件');
  await expect(hint).toBeVisible();
  const countBox = (await count.boundingBox())!;
  const hintBox = (await hint.boundingBox())!;
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
