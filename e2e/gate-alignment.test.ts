import { listOrganizations } from '../src/shared/operations/operator/list-organizations.ts';
import { mockOperation } from './operations.ts';
import { expect, test } from './fixtures.ts';
import {
  applyTheme,
  findTargetSizeViolations,
  findOverflowViolations,
  expectNoA11yViolationsInThemes,
  signIn,
} from './helpers.ts';

for (const path of ['/login', '/signup', '/invite', '/terms']) {
  test(`${path} の静かな操作とロゴの絵が本文の左端にそろう`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.locator('.brand-name').evaluate((img: HTMLImageElement) => img.decode());
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['simple_light', 'simple_dark', 'medieval', 'modern']) {
        await applyTheme(page, theme);
        const offsets = await page
          .locator('.gate-sheet, .onboarding-content')
          .first()
          .evaluate((sheet) => {
            const title = sheet.querySelector('h1')!.getBoundingClientRect();
            const image = document.querySelector('.gate-brand .brand-name')!.getBoundingClientRect();
            const logoAnchor = document.querySelector('.onboarding-header')?.getBoundingClientRect().left ?? title.left;
            const button = sheet.querySelector('.form-actions > .btn.is-sm.is-quiet:first-child')!;
            const text = document.createRange();
            text.selectNodeContents(button);
            return {
              text: text.getBoundingClientRect().left - title.left,
              // 画像のアルファが始まる位置は600px中34px。
              logo: image.left + (image.width * 34) / 600 - logoAnchor,
            };
          });
        expect(Math.abs(offsets.text)).toBeLessThan(1);
        expect(Math.abs(offsets.logo)).toBeLessThan(1);
      }
    }
    await expectNoA11yViolationsInThemes(page, path === '/terms' ? 'terms' : 'invite', []);
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await findTargetSizeViolations(page)).toEqual([]);
    expect(await findOverflowViolations(page)).toEqual([]);
  });
}

test('390px の管理と運用で静かな操作が積んだ行の左端にそろう', async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 900 });
  await signIn(context, baseURL, 'admin');
  for (const path of ['/aoba/admin', '/operator']) {
    if (path === '/operator') {
      await signIn(context, baseURL, 'operator');
      await mockOperation(page, listOrganizations, {
        organizations: [
          {
            slug: 'kamome',
            name: 'かもめ社',
            kind: 'team',
            suspended_at: '2026-10-10T00:00:00.000Z',
            purge_on: null,
            purge_due: false,
            created_at: '2026-10-01T00:00:00.000Z',
            admin_status: 'active',
            seats: { used: 5, limit: 15 },
            workspace_count: 3,
            task_count: 1284,
            attachment_quota_bytes: 32212254720,
            last_used_at: null,
            self_created: false,
            trial_ends_on: null,
            trial_expired: false,
          },
        ],
      });
    }
    await page.goto(path);
    const button = page
      .locator(
        '.table.is-stacked td.is-actions > .btn.is-quiet, .table.is-stacked .table-actions > .btn.is-quiet:first-child',
      )
      .first();
    await expect(button).toBeVisible();
    const offset = await button.evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      return range.getBoundingClientRect().left - button.closest('td')!.getBoundingClientRect().left;
    });
    expect(Math.abs(offset)).toBeLessThan(1);
    if (path === '/operator') {
      const stopped = page
        .locator('.table.is-stacked tr')
        .filter({ has: page.getByRole('button', { name: /再開する/ }) })
        .first();
      await expect(stopped).toBeVisible();
      for (const theme of ['simple_light', 'simple_dark', 'medieval', 'modern']) {
        await applyTheme(page, theme);
        const boxes = await stopped.locator('td.is-actions .btn').evaluateAll((buttons) =>
          buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(button);
            return {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              textLeft: range.getBoundingClientRect().left,
              contentLeft: button.closest('td')!.getBoundingClientRect().left,
            };
          }),
        );
        expect(boxes).toHaveLength(3);
        expect(new Set(boxes.map((box) => box.top)).size).toBeLessThanOrEqual(2);
        const lines = [...new Set(boxes.map((box) => box.top))].sort((a, b) => a - b);
        for (const top of lines) {
          const first = boxes.find((box) => box.top === top)!;
          expect(Math.abs(first.textLeft - first.contentLeft)).toBeLessThan(1);
        }
        if (lines.length === 2) {
          const firstBottom = Math.max(...boxes.filter((box) => box.top === lines[0]).map((box) => box.bottom));
          expect(lines[1] - firstBottom).toBeGreaterThanOrEqual(0);
          expect(lines[1] - firstBottom).toBeLessThanOrEqual(4);
        }
      }
    }
    const buttons = page.locator('.table.is-stacked td.is-actions .btn');
    for (const button of await buttons.all()) {
      const box = await button.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test('ダイアログの静かな操作には枠の外の補正を適用しない', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('.gate-title')).toBeVisible();
  const margin = await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.className = 'dialog';
    panel.innerHTML = '<div class="form-actions"><button class="btn is-sm is-quiet">もう一度試す</button></div>';
    document.body.append(panel);
    const margin = getComputedStyle(panel.querySelector('button')!).marginInlineStart;
    panel.remove();
    return margin;
  });
  expect(margin).toBe('0px');
});

test('積んだ行に枠付き操作が混ざっても折り返した枠は本文より左へ出ない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/login');
  await expect(page.locator('.gate-title')).toBeVisible();
  const offsets = await page.evaluate(() => {
    const table = document.createElement('table');
    table.className = 'table is-stacked';
    table.style.width = '200px';
    table.innerHTML =
      '<tbody><tr><td class="is-actions"><span class="table-actions is-wrap"><button class="btn is-sm is-quiet is-danger">停止する</button><button class="btn is-sm">管理者を指名</button><button class="btn is-sm is-danger">停止する</button></span></td></tr><tr><td class="is-actions"><button class="btn is-sm is-quiet is-danger">先頭</button><button class="btn is-sm is-quiet">次</button></td></tr></tbody>';
    document.body.append(table);
    const actions = table.querySelector('.table-actions')!;
    const left = actions.closest('td')!.getBoundingClientRect().left;
    const first = actions.querySelector('button')!;
    const range = document.createRange();
    range.selectNodeContents(first);
    const result = {
      group: actions.getBoundingClientRect().left - left,
      firstText: range.getBoundingClientRect().left - left,
      quietDangerBorders: [...table.querySelectorAll('.btn.is-quiet.is-danger')].map(
        (button) => getComputedStyle(button).borderLeftColor,
      ),
      bordered: [...actions.querySelectorAll('.btn:not(.is-quiet)')].map(
        (button) => button.getBoundingClientRect().left - left,
      ),
      nextMargin: getComputedStyle(table.querySelector('tr:last-child button:last-child')!).marginInlineStart,
    };
    table.remove();
    return result;
  });
  expect(offsets.group).toBe(0);
  expect(Math.abs(offsets.firstText)).toBeLessThan(1);
  expect(offsets.quietDangerBorders).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  for (const offset of offsets.bordered) expect(offset).toBeGreaterThanOrEqual(0);
  expect(offsets.nextMargin).toBe('0px');
});
