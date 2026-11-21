import { openCatalog } from './design-samples.ts';
import { expect, test } from './fixtures.ts';

const THEMES = ['simple_light', 'simple_dark', 'modern'] as const;

// 操作部品の枠（#859）。入力欄とボタンの枠は --color-control-edge の値で、記録の区切り線（--color-line）とは別
const controlEdge: Record<string, string> = {
  simple_light: 'rgb(133, 135, 142)',
  simple_dark: 'rgb(110, 110, 120)',
  modern: 'rgb(70, 115, 159)',
};
// カタログを開くのは1回にし、テーマはページを開いたまま切り替える（テーマごとに開き直さない）。どのテーマで落ちたかは test.step の名前で分かる
test('操作部品の枠の色: 3つのテーマ', async ({ page }) => {
  const errors = await openCatalog(page);
  for (const [theme, edge] of Object.entries(controlEdge)) {
    await test.step(theme, async () => {
      await page.locator(`[data-pick-theme][value="${theme}"]`).check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const selector of [
        '.input',
        '.select',
        '.search',
        '.btn:not(.is-primary):not(.is-quiet):not(.is-danger):not(.is-google)',
      ]) {
        const control = page.locator(`#main ${selector}, main ${selector}, ${selector}`).first();
        await expect(control).toHaveCSS('border-top-color', edge);
      }
    });
  }
  expect(errors).toEqual([]);
});

test('組織のホームの見本: タスク行とゴールの貼り紙に本番と同じ情報を出す', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const errors = await openCatalog(page, 'today.html');
  const rows = page.locator('.entry');
  await expect(rows.first()).toBeVisible();
  await expect(rows.locator('.status-dot, .is-carry')).toHaveCount(0);
  await expect(rows.locator('.entry-meta').getByText('区分：', { exact: true })).toHaveCount(0);

  const carried = rows.filter({ has: page.locator('[data-task="t8"]') });
  await expect(carried.locator('.entry-meta .tag')).toHaveText('受託開発チーム');
  await expect(carried.locator('.entry-meta .is-name')).toHaveText('スプリント：第14回');
  await expect(carried.locator('.props-note')).toHaveText('1日前に印を付けた');
  await expect(carried.getByText('決済の失敗をすぐ検知できる', { exact: true })).toHaveCount(0);
  await expect(carried.locator('.entry-chips .chip')).toContainText('期日切れ');
  await expect(carried.locator('.entry-chips .pts')).toHaveText('1');
  await expect(carried.locator('.entry-chips').getByRole('img', { name: 'ミナト' })).toBeVisible();

  const imported = rows.filter({ has: page.locator('[data-task="t11"]') });
  await expect(imported.locator('.entry-meta .is-name')).toHaveText(['スプリント：第14回', 'リポジトリ：shop']);
  await expect(imported.locator('.source-key')).toHaveText('acme/shop#418');
  const sourceDone = rows.filter({ has: page.locator('[data-task="t12"]') });
  await expect(sourceDone.locator('.source-key')).toHaveText('SHOP-131');
  await expect(sourceDone.locator('.chip.is-ok')).toHaveText('取り込み元で完了');
  await expect(page.locator('.tally').filter({ hasText: '取り込み元で完了' }).locator('.is-ok dd')).toHaveText('1');

  const goals = page.locator('.notice-grid > .notice');
  await expect(goals).toHaveCount(2);
  for (const [i, workspace] of ['受託開発チーム', '社内ツール'].entries()) {
    const goal = goals.nth(i);
    await expect(goal.locator(':scope > *')).toHaveCount(3);
    await expect(goal.locator('.notice-label')).toHaveText('スプリントゴール');
    await expect(goal.locator('.notice-title.is-goal')).not.toBeEmpty();
    await expect(goal.locator('.notice-meta')).toHaveText(workspace);
  }
  expect(errors).toEqual([]);
});

test('スプリントの見本: ゴールの貼り紙はラベルとゴールだけを出す', async ({ page }) => {
  const errors = await openCatalog(page, 'sprint.html');
  const goal = page.locator('.notice').filter({ has: page.locator('.notice-title.is-goal') });
  await expect(goal).toBeVisible();
  await expect(goal.locator(':scope > *')).toHaveCount(2);
  await expect(goal.locator('.notice-label')).toHaveText('スプリントゴール');
  await expect(goal.locator('.notice-title.is-goal')).toHaveText(
    '会員ポイントの付与を管理画面で確かめられる所まで進め、決済の障害の検知を入れる',
  );
  expect(errors).toEqual([]);
});

for (const screen of ['today.html', 'sprint.html']) {
  test(`ゴールが空のスプリントの見本では貼り紙を置かない: ${screen}`, async ({ page }) => {
    const errors = await openCatalog(page, screen);
    const goals = page.locator('.notice-title.is-goal');
    await expect(goals.first()).toBeVisible();
    await page.evaluate(() => {
      const { SQ } = window as unknown as {
        SQ: { D: { sprints: Record<string, { goal?: string }> }; redraw: () => void };
      };
      for (const sprint of Object.values(SQ.D.sprints)) sprint.goal = '';
      SQ.redraw();
    });
    await expect(goals).toHaveCount(0);
    await expect(page.locator(screen === 'today.html' ? '.notice-grid' : '.notice')).toHaveCount(0);
    await expect(page.locator('.page-title')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('組織のホームの見本: 同名のワークスペースの貼り紙は ID 順に並ぶ', async ({ page }) => {
  const errors = await openCatalog(page, 'today.html');
  const goals = page.locator('.notice-grid > .notice .notice-title.is-goal');
  await expect(goals).toHaveCount(2);
  const original = await goals.allTextContents();
  await page.evaluate(() => {
    const { SQ } = window as unknown as {
      SQ: {
        D: { workspaces: Record<string, { name: string }>; sprints: Record<string, unknown> };
        redraw: () => void;
      };
    };
    SQ.D.workspaces.wb.name = SQ.D.workspaces.wa.name;
    SQ.D.sprints = Object.fromEntries(Object.entries(SQ.D.sprints).reverse());
    SQ.redraw();
  });
  await expect(page.locator('.notice-grid .notice-meta')).toHaveText(['受託開発チーム', '受託開発チーム']);
  await expect(goals).toHaveText(original);
  expect(errors).toEqual([]);
});

test('組織のホームの見本: 390px で長いワークスペース名とスプリント名がタスク行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openCatalog(page, 'today.html');
  const longName = 'DevelopmentTeam'.repeat(6);
  await page.evaluate((name) => {
    const { SQ } = window as unknown as {
      SQ: { D: { workspaces: { wa: { name: string } }; sprints: { sp14: { name: string } } }; redraw: () => void };
    };
    SQ.D.workspaces.wa.name = name;
    SQ.D.sprints.sp14.name = name;
    SQ.redraw();
  }, longName);

  const row = page.locator('.entry').filter({ has: page.locator('[data-task="t8"]') });
  await expect(row.locator('.entry-meta .tag')).toHaveText(longName);
  await expect(row.locator('.entry-meta .is-name')).toHaveText(`スプリント：${longName}`);
  await expect(row.locator('.entry-chips').getByRole('img', { name: 'ミナト' })).toBeVisible();
  await expect(row.locator('.entry-actions .done-btn')).toBeVisible();
  expect(await row.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    await row.evaluate((element) => element.clientWidth),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

for (const width of [390, 320]) {
  test(`見本のカタログ: ワークスペースの行は ${width}px で長い名前を折り返し、ロールと chevron を折り返さずに縦の中央に置く`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await openCatalog(page);
    const rows = page.locator('section[aria-labelledby="pane-demo-workspaces"] .pane-link');
    await expect(rows).toHaveCount(3);
    const row = rows.nth(2);
    await expect(row).toContainText('長い名前のワークスペース（受託開発チームの第二期・保守と追加案件をまとめて見る）');
    const box = await row.evaluate((element) => {
      const nameElement = element.querySelector('b')!;
      const roleElement = element.querySelector('.pane-link-role')!;
      const chevronElement = element.querySelector('.ico')!;
      const name = nameElement.getBoundingClientRect();
      const role = roleElement.getBoundingClientRect();
      const chevron = chevronElement.getBoundingClientRect();
      const self = element.getBoundingClientRect();
      const body = element.closest('.pane-body')!.getBoundingClientRect();
      const roleStyle = getComputedStyle(roleElement);
      return {
        nameLines: Math.round(name.height / parseFloat(getComputedStyle(nameElement).lineHeight)),
        roleLines: Math.round(role.height / parseFloat(roleStyle.lineHeight)),
        roleShrink: roleStyle.flexShrink,
        roleWrap: roleStyle.whiteSpace,
        chevronShrink: getComputedStyle(chevronElement).flexShrink,
        nameBeforeRole: name.right <= role.left,
        roleBeforeChevron: role.right <= chevron.left,
        rowCenter: self.top + self.height / 2,
        roleCenter: role.top + role.height / 2,
        chevronCenter: chevron.top + chevron.height / 2,
        rowInsideBody: self.left >= body.left && self.right <= body.right,
      };
    });
    // 名前は2行以上に折り返し、ロールは縮まず折り返さずに1行のまま、chevron も縮まない
    expect(box.nameLines).toBeGreaterThanOrEqual(2);
    expect(box.roleLines).toBe(1);
    expect([box.roleShrink, box.roleWrap, box.chevronShrink]).toEqual(['0', 'nowrap', '0']);
    // 名前、ロール、chevron の順に重ならずに並び、行は面の中身からはみ出さない
    expect(box.nameBeforeRole).toBe(true);
    expect(box.roleBeforeChevron).toBe(true);
    expect(box.rowInsideBody).toBe(true);
    // ロールと chevron は行の縦の中央に付く
    expect(Math.abs(box.roleCenter - box.rowCenter)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.chevronCenter - box.rowCenter)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

test('見本のカタログ: 320px で、3つのテーマともページが横にはみ出さない', async ({ page }) => {
  const width = 320;
  await page.setViewportSize({ width, height: 900 });
  const errors = await openCatalog(page);
  await expect(page.locator('#assistant .assist-sheet')).toBeVisible();
  for (const theme of THEMES) {
    await test.step(theme, async () => {
      await page.locator(`[data-pick-theme][value="${theme}"]`).check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // 落ちたときに直す所が分かるよう、右端を越えた要素のうち、親は越えていない一番外側のものを節の id つきで挙げる。
      // 中で横に送る入れ物（overflow-x が visible でないもの。引き出しや Markdown のコード）の中身は、ページを広げないので数えず、
      // 入れ物そのものが越えたときだけ挙げる
      const read = await page.evaluate((viewport) => {
        const over = (el: Element) => el.getBoundingClientRect().right > viewport + 0.5;
        const clipped = (el: Element) => {
          for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            if (getComputedStyle(parent).overflowX !== 'visible') return true;
          }
          return false;
        };
        const offenders = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().width > 0 && over(el) && !over(el.parentElement!) && !clipped(el))
          .map(
            (el) =>
              `${el.closest('section[id]')?.id ?? '-'} ${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}`,
          );
        return { scrollWidth: document.documentElement.scrollWidth, offenders };
      }, width);
      expect(read.offenders).toEqual([]);
      expect(read.scrollWidth).toBeLessThanOrEqual(width);
    });
  }
  expect(errors).toEqual([]);
});
