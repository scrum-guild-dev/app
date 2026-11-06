// シンプルの見た目と密度（#828）。docs/design.md の「テーマごとの違い」の「角と線」と、「どのテーマにも共通すること」の「密度」。
// シンプルだけが細い上の線、小さな角、枠の無い状態の印になり、中世風と現代風は今の形のまま残ることと、
// 広い幅でマウスで操作する画面だけ行を詰め、狭い幅では押せる範囲 44px のための余白を残すことを、今日やることの画面で確かめる。
// 画面が出す行と貼り紙を決めるため、`today` の応答をテストの中で組む（実行する日にも seed の日付にも依存しない）
import { today } from '../src/shared/operations/organization/index.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { expect, test } from './fixtures.ts';
import { applyTheme, signIn } from './helpers.ts';
import { mockOperation } from './operations.ts';

const TODAY = '2026-11-04';
const WORKSPACE = { id: '019a0000-0000-7000-8000-000000000401', name: '受託開発チーム' };

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
    repository: null,
    sprint: null,
    ...overrides,
  };
}

test.beforeEach(async ({ page, context, baseURL }) => {
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
});

test('シンプルは上の色の線が細く角が小さく、状態の印に枠を引かない。中世風と現代風は今の形のまま', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/aoba');
  const notice = page.locator('.notice');
  const overdue = page.locator('.entry .chip.is-danger');
  await expect(notice).toHaveCount(1);
  await expect(overdue).toHaveCount(1);

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

test('広い幅でマウスで操作する画面は行を詰め、狭い幅では押せる範囲 44px のための余白を残す', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/aoba');
  const entry = page.locator('.entry').filter({ hasText: '期日切れの行' });
  const navItem = page.locator('.nav-item[aria-current="page"]');
  await expect(entry).toBeVisible();

  // 詰めるのは全テーマで同じ
  for (const theme of ['simple_light', 'medieval', 'modern']) {
    await applyTheme(page, theme);
    await expect(entry, theme).toHaveCSS('padding-top', '8px');
    await expect(entry, theme).toHaveCSS('min-height', '48px');
    await expect(navItem, theme).toHaveCSS('padding-top', '4px');
  }

  await page.setViewportSize({ width: 390, height: 900 });
  await applyTheme(page, 'simple_light');
  await expect(entry).toHaveCSS('padding-top', '12px');
  await expect(entry).toHaveCSS('min-height', '60px');
  await expect(navItem).toHaveCSS('padding-top', '7px');
});
