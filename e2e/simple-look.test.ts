// シンプルの見た目と密度（#828）。docs/design.md の「テーマごとの違い」の「角と線」と、「どのテーマにも共通すること」の「密度」。
// シンプルだけが細い上の色の線、小さな角、枠の無い状態の印になり、見せ場のゲージの角と、中世風と現代風は今の形のまま残ることと、
// 761px 以上でマウスだけで操作する画面だけ行を詰め、760px 以下と指で押す画面では押せる範囲 44px のための余白を残すことを確かめる。
// 今日やることの画面は、行と貼り紙を決めるため `today` の応答をテストの中で組む（実行する日にも seed の日付にも依存しない）。
// バックログの木、メンバーの表、計画のレーンは seed のまま開く
import type { BrowserContext, Page } from '@playwright/test';
import { today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { expect, test } from './fixtures.ts';
import { applyTheme, signIn } from './helpers.ts';
import { mockOperation } from './operations.ts';

const TODAY = '2026-11-04';
const WORKSPACE = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };
const WORKSPACE_PATH = `/aoba/w/${WORKSPACE.id}`;

function row(id: string, overrides: Partial<TodayTask> = {}): TodayTask {
  return {
    id,
    title: id,
    points: null,
    due_on: null,
    today_on: null,
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
    ...overrides,
  };
}

// 一般のユーザー（ハルカ）で、期日切れの行1つとスプリントゴールの貼り紙を持つ今日やることを開けるようにする
async function prepareToday(page: Page, context: BrowserContext, baseURL: string | undefined): Promise<void> {
  await signIn(context, baseURL, 'member');
  await mockOperation(
    page,
    today,
    { slug: 'aoba' },
    {
      tasks: [row('期日切れの行', { due_on: '2026-11-02' })],
      sprint_goals: [{ workspace_id: WORKSPACE.id, workspace_name: WORKSPACE.name, goal: '請求の画面を出す' }],
    },
  );
}

test.describe('今日やることの画面', () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    await prepareToday(page, context, baseURL);
  });

  test('シンプルは上の色の線が細く角が小さく、状態の印に枠を引かない。中世風と現代風は今の形のまま', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/aoba');
    const notice = page.locator('.notice');
    const overdue = page.locator('.entry .chip.is-danger');
    await expect(notice).toHaveCount(1);
    await expect(overdue).toHaveCount(1);
    await expect(page.locator('.gauge')).toHaveCount(0);

    for (const [theme, edge, radius, framed] of [
      ['simple_light', '2px', '4px', false],
      ['simple_dark', '2px', '4px', false],
      ['medieval', '5px', '2px', true],
      // 現代風の貼り紙は、テーマの飾りが光る枠の 1px にする
      ['modern', '1px', '2px', true],
    ] as const) {
      await applyTheme(page, theme);
      await expect(notice, theme).toHaveCSS('border-top-width', edge);
      await expect(notice, theme).toHaveCSS('border-top-left-radius', radius);
      // 状態の印の枠は、シンプルでは透明（地の色で示す）、ほかは文字と同じ色
      const border = await overdue.evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.borderTopColor, matchesText: style.borderTopColor === style.color };
      });
      if (framed) expect(border.matchesText, theme).toBe(true);
      else expect(border.color, theme).toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('プロフィールの経験値ゲージは4つの見た目で従来の丸みを保つ', async ({ page }) => {
    await page.goto('/aoba/me');
    const gauge = page.locator('.gauge');
    await expect(gauge).toHaveCount(1);
    for (const [theme, radius] of [
      ['simple_light', '6px'],
      ['simple_dark', '6px'],
      ['medieval', '2px'],
      ['modern', '2px'],
    ] as const) {
      await applyTheme(page, theme);
      await expect(gauge, theme).toHaveCSS('border-top-left-radius', radius);
    }
  });

  test('OS がダークなら、テーマの属性が無いときとシンプル（自動）でも、シンプル（ダーク）の地になる', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/aoba');
    await expect(page.locator('.notice')).toHaveCount(1);
    const body = page.locator('body');

    await page.evaluate(async () => {
      delete document.documentElement.dataset.theme;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(body).toHaveCSS('background-color', 'rgb(18, 18, 20)');
    for (const [theme, background] of [
      ['simple', 'rgb(18, 18, 20)'],
      ['simple_dark', 'rgb(18, 18, 20)'],
      // シンプル（ライト）は OS がダークでもライトのまま
      ['simple_light', 'rgb(247, 247, 248)'],
    ] as const) {
      await applyTheme(page, theme);
      await expect(body, theme).toHaveCSS('background-color', background);
    }
  });

  test('761px 以上でマウスだけで操作する画面は行を詰め、760px 以下では押せる範囲 44px のための余白を残す', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/aoba');
    const entry = page.locator('.entry').filter({ hasText: '期日切れの行' });
    const navItem = page.locator('.nav-item[aria-current="page"]');
    await expect(entry).toBeVisible();

    // 詰めるのは全テーマで同じ
    for (const theme of ['simple_light', 'simple_dark', 'medieval', 'modern']) {
      await applyTheme(page, theme);
      await expect(entry, theme).toHaveCSS('padding-top', '8px');
      await expect(entry, theme).toHaveCSS('min-height', '48px');
      await expect(navItem, theme).toHaveCSS('padding-top', '4px');
    }

    // 境目は 761px と 760px
    await applyTheme(page, 'simple_light');
    await page.setViewportSize({ width: 761, height: 900 });
    await expect(entry).toHaveCSS('padding-top', '8px');
    for (const width of [760, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(entry, `${width}px`).toHaveCSS('padding-top', '12px');
      await expect(entry, `${width}px`).toHaveCSS('min-height', '60px');
      await expect(navItem, `${width}px`).toHaveCSS('padding-top', '7px');
      await expect(navItem, `${width}px`).toHaveCSS('min-height', '44px');
    }
  });
});

test.describe('指で押す 1024px の端末', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, context, baseURL }) => {
    await prepareToday(page, context, baseURL);
  });

  test('広い幅でも行を詰めず、押せる範囲 44px のための余白を残す', async ({ page }) => {
    await page.goto('/aoba');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const entry = page.locator('.entry').filter({ hasText: '期日切れの行' });
    await expect(entry).toBeVisible();
    await expect(entry).toHaveCSS('padding-top', '12px');
    await expect(entry).toHaveCSS('min-height', '60px');
    await expect(page.locator('.nav-item[aria-current="page"]')).toHaveCSS('min-height', '44px');
  });
});

test.describe('バックログの木、メンバーの表、計画のレーン', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('バックログの木の行とメンバーの表のセルも、広い幅で詰め、760px 以下では詰めない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(WORKSPACE_PATH);
    const treeRow = page.locator('.tree-row').first();
    await expect(treeRow).toBeVisible();
    await expect(treeRow).toHaveCSS('padding-top', '8px');
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(treeRow).toHaveCSS('padding-top', '12px');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${WORKSPACE_PATH}/members`);
    const cell = page.locator('.table tbody td').first();
    await expect(cell).toBeVisible();
    await expect(cell).toHaveCSS('padding-top', '8px');
  });

  test('計画のレーンの上の色の線は、シンプルだけ細い', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${WORKSPACE_PATH}/plan`);
    const lane = page.locator('.lane').first();
    await expect(lane).toBeVisible();
    for (const [theme, edge] of [
      ['simple_light', '2px'],
      ['simple_dark', '2px'],
      ['medieval', '5px'],
      ['modern', '5px'],
    ] as const) {
      await applyTheme(page, theme);
      await expect(lane, theme).toHaveCSS('border-top-width', edge);
    }
  });
});
