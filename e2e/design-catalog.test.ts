import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.ts';

for (const width of [1280, 1024, 761, 760, 390, 320]) {
  for (const theme of ['simple_light', 'simple_dark', 'medieval', 'modern']) {
    test(`長い名前のメニューの見本: ${width}px / ${theme}`, async ({ page }) => {
      // カタログはアプリの配信対象外なので、共有の見本ファイルをそのまま返す。
      const files: Record<string, string> = {
        'index.html': 'text/html',
        'tokens.css': 'text/css',
        'components.css': 'text/css',
        'icons.js': 'text/javascript',
        'art.js': 'text/javascript',
        'sample-data.js': 'text/javascript',
        'kit.js': 'text/javascript',
      };
      await page.route('**/__design-catalog/**', async (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop()!;
        const contentType = files[name];
        if (!contentType) return route.fulfill({ status: 404, body: '' });
        await route.fulfill({
          contentType,
          body: readFileSync(new URL(`../design/${name}`, import.meta.url)),
        });
      });
      // CI のネットワークやフォント取得の成否で寸法が変わらないようにする。
      for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
        await page.route(`https://${host}/**`, (route) => route.fulfill({ body: '' }));
      }
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.goto('/__design-catalog/index.html');
      await page.locator('#toc a[href="#nav-wrapping"]').click();
      await expect(page).toHaveURL(/#nav-wrapping$/);
      const section = page.locator('#nav-wrapping');
      const labels = section.locator('.is-wrapping .nav-item-label');
      await expect(labels).toHaveCount(3);
      await expect(labels.nth(0)).toHaveText('こもれび工房の Wiki');
      await expect(labels.nth(1)).toContainText('共同研究開発チーム');
      const longName = (await labels.nth(2).innerText()).replace('の Wiki', '');
      expect(longName).toMatch(/^[a-zA-Z0-9]{80}$/);
      await page.setViewportSize({ width, height: 1000 });
      await page.locator(`[data-pick-theme][value="${theme}"]`).check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const [index, nav] of (await section.locator('.nav').all()).entries()) {
        await nav.scrollIntoViewIfNeeded();
        await expect(nav).toHaveCSS('display', width <= 760 ? 'flex' : 'grid');
        await expect(nav.locator('svg use')).toHaveCount(3);
        await expect(nav.locator('[aria-current="page"]')).toHaveClass(/is-wrapping/);
        const label = nav.locator('.is-wrapping .nav-item-label');
        await expect(label).toHaveCSS('overflow-wrap', 'anywhere');
        const size = await label.evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          scroll: el.scrollWidth,
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          left: el.getBoundingClientRect().left,
          right: el.getBoundingClientRect().right,
          itemLeft: el.parentElement!.getBoundingClientRect().left,
          itemRight: el.parentElement!.getBoundingClientRect().right,
        }));
        expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
        expect(size.left).toBeGreaterThanOrEqual(size.itemLeft);
        expect(size.right).toBeLessThanOrEqual(size.itemRight + 1);
        if (width <= 760) expect(size.width).toBeLessThanOrEqual(192.1);
        if (width > 760 && index > 0) expect(size.height).toBeGreaterThanOrEqual(size.lineHeight * 2 - 1);
        expect(size.scrollHeight).toBeLessThanOrEqual(size.clientHeight + 1);
        if (width <= 390) {
          const scroll = await nav.evaluate((el) => ({ width: el.clientWidth, content: el.scrollWidth }));
          expect(scroll.content).toBeGreaterThan(scroll.width);
        }
        // 帯を最後まで送ると、隣の短い項目にも届く。
        await nav.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        await expect(nav.locator('.nav-item').last()).toBeInViewport();
      }
      const bounds = await section.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      // 他の既存の見本は 320/390px で横にはみ出す。今回の見本が幅を増やさないことを確かめる。
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      await section.evaluate((el) => el.remove());
      const existingWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidth).toBeLessThanOrEqual(Math.max(width, existingWidth));
      expect(errors).toEqual([]);
    });
  }
}

test('見本の引き出し: タブを切り替えても、作り直しても、書きかけのコメントを残し、別のタスクへ移ると捨てる', async ({
  page,
}) => {
  // スプリントの見本を共有の見本ファイルのまま返す（アプリの配信対象外）。
  const files: Record<string, string> = {
    'sprint.html': 'text/html',
    'tokens.css': 'text/css',
    'components.css': 'text/css',
    'icons.js': 'text/javascript',
    'art.js': 'text/javascript',
    'sample-data.js': 'text/javascript',
    'kit.js': 'text/javascript',
  };
  await page.route('**/__design-catalog/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    const contentType = files[name];
    if (!contentType) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ contentType, body: readFileSync(new URL(`../design/${name}`, import.meta.url)) });
  });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    await page.route(`https://${host}/**`, (route) => route.fulfill({ body: '' }));
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/__design-catalog/sprint.html');
  const tasks = page.locator('[data-task]');
  const firstId = await tasks.first().getAttribute('data-task');
  const secondId = await tasks.nth(1).getAttribute('data-task');
  expect(secondId).not.toBe(firstId);
  await tasks.first().click();
  const drawer = page.locator('#drawer');
  const comment = drawer.locator('#new-comment');
  await comment.fill('書きかけのコメント');
  // 要素を覚え、タブの切り替えで引き出しが作り直されないこと（同じ要素のままなこと）を確かめる
  const mark = () => comment.evaluate((el) => ((window as unknown as { __kept?: Element }).__kept = el));
  const isKept = () => comment.evaluate((el) => (window as unknown as { __kept?: Element }).__kept === el);
  await mark();
  const comments = drawer.locator('[data-tab="comments"]');
  const history = drawer.locator('[data-tab="history"]');
  const expectTab = async (on: typeof comments, off: typeof comments) => {
    await expect(on).toHaveAttribute('aria-selected', 'true');
    await expect(on).toHaveAttribute('tabindex', '0');
    await expect(on).toBeFocused();
    await expect(off).toHaveAttribute('aria-selected', 'false');
    await expect(off).toHaveAttribute('tabindex', '-1');
  };

  // クリックで往復する
  await history.click();
  await expectTab(history, comments);
  await expect(drawer.locator('#drawer-panel-comments')).toBeHidden();
  await expect(drawer.locator('#drawer-panel-history')).toBeVisible();
  await comments.click();
  await expectTab(comments, history);
  await expect(comment).toHaveValue('書きかけのコメント');
  expect(await isKept()).toBe(true);

  // 矢印キーと End / Home でも、引き出しを作り直さずに切り替わる
  await comments.focus();
  await page.keyboard.press('ArrowRight');
  await expectTab(history, comments);
  await page.keyboard.press('Home');
  await expectTab(comments, history);
  await page.keyboard.press('End');
  await expectTab(history, comments);
  await page.keyboard.press('ArrowLeft');
  await expectTab(comments, history);
  await expect(comment).toHaveValue('書きかけのコメント');
  expect(await isKept()).toBe(true);

  // 引き出しを実際に作り直す操作（狭い幅への切り替えで renderDrawer が走る）でも、書きかけを戻す
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');
  expect(await isKept()).toBe(false);

  // 引き出しの「次のタスク」で移り、書きかけを捨てると、移った先のコメント欄は空になる
  const title = drawer.locator('#drawer-title');
  const firstTitle = await title.textContent();
  expect(firstTitle).toBeTruthy();
  await drawer.locator('[data-drawer-step="1"]').click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(title).not.toHaveText(firstTitle ?? '');
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  // 「前のタスク」で戻っても、捨てた書きかけは戻らない
  await drawer.locator('[data-drawer-step="-1"]').click();
  await expect(title).toHaveText(firstTitle ?? '');
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  await drawer.locator('#new-comment').fill('書きかけのコメント');

  // 書きかけがあるまま、開いているのと同じタスクのリンクを押すと、確かめずに書きかけを残し、コメントのタブへ戻す
  const dialog = page.locator('#dialog');
  await history.click();
  await page.locator(`[data-task="${firstId}"]`).first().dispatchEvent('click');
  await expect(dialog).toBeHidden();
  await expect(comments).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');

  // 引き出しを開いたまま別のタスクのリンク（アシスタントの答えの参照と同じ data-task）を押すと、移る前に確かめる。
  // 引き出しの後ろの行は幕で押せないので、行の data-task に click を送って同じ経路を通す
  const otherTask = page.locator(`[data-task="${secondId}"]`).first();
  const secondTitle = (await otherTask.innerText()).trim();
  expect(secondTitle).toBeTruthy();
  expect(secondTitle).not.toBe(firstTitle);
  await otherTask.dispatchEvent('click');
  await page.getByRole('button', { name: '書き続ける' }).click();
  await expect(title).toHaveText(firstTitle ?? '');
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');
  // 「書き続ける」の後に閉じて捨てると、前に押したタスクへは移らずに閉じる
  await drawer.locator('.drawer-close').click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(drawer).toBeHidden();
  await tasks.first().click();
  await drawer.locator('#new-comment').fill('書きかけのコメント');
  await otherTask.dispatchEvent('click');
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(title).toHaveText(secondTitle);
  await expect(drawer.locator('#new-comment')).toHaveValue('');

  // パレット（Ctrl+K）の答えの参照から別のタスクを開くときは、確認がパレットの上に出る。
  // 「書き続ける」ならパレットを残し、「捨てる」ならパレットを閉じて移る
  await drawer.locator('#new-comment').fill('書きかけのコメント');
  await page.keyboard.press('Control+k');
  const palette = page.locator('#assist-palette');
  await expect(palette).toBeVisible();
  const ask = palette.locator('input, textarea').first();
  await ask.fill('遅れているタスクは');
  await ask.press('Enter');
  const ref = palette.locator(`.assist-refs a[data-task]:not([data-task="${secondId}"])`).first();
  await expect(ref).toBeVisible();
  const refTitle = (await ref.innerText()).trim();
  await ref.click();
  await page.getByRole('button', { name: '書き続ける' }).click();
  await expect(palette).toBeVisible();
  await expect(ref).toBeFocused();
  await expect(title).toHaveText(secondTitle);
  await ref.click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(palette).toBeHidden();
  await expect(title).toHaveText(refTitle);
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  await expect(drawer.locator('.drawer-close')).toBeFocused();
  await drawer.locator('#new-comment').fill('書きかけのコメント');

  // 閉じて別のタスクを開くと、コメント欄は空になる
  await drawer.locator('.drawer-close').click();
  await page.getByRole('button', { name: '捨てる' }).click();
  await expect(drawer).toBeHidden();
  await tasks.nth(1).click();
  await expect(drawer.locator('#new-comment')).toHaveValue('');
  expect(errors).toEqual([]);
});

// 操作部品の枠（#859）。入力欄とボタンの枠は --color-control-edge の値で、記録の区切り線（--color-line）とは別
const controlEdge: Record<string, string> = {
  simple_light: 'rgb(133, 135, 142)',
  simple_dark: 'rgb(110, 110, 120)',
  medieval: 'rgb(127, 136, 144)',
  modern: 'rgb(70, 115, 159)',
};
for (const theme of Object.keys(controlEdge)) {
  test(`操作部品の枠の色: ${theme}`, async ({ page }) => {
    const files: Record<string, string> = {
      'index.html': 'text/html',
      'tokens.css': 'text/css',
      'components.css': 'text/css',
      'icons.js': 'text/javascript',
      'art.js': 'text/javascript',
      'sample-data.js': 'text/javascript',
      'kit.js': 'text/javascript',
    };
    await page.route('**/__design-catalog/**', async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop()!;
      const contentType = files[name];
      if (!contentType) return route.fulfill({ status: 404, body: '' });
      await route.fulfill({ contentType, body: readFileSync(new URL(`../design/${name}`, import.meta.url)) });
    });
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
      await page.route(`https://${host}/**`, (route) => route.fulfill({ body: '' }));
    }
    await page.goto('/__design-catalog/index.html');
    await page.locator(`[data-pick-theme][value="${theme}"]`).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of [
      '.input',
      '.select',
      '.search',
      '.btn:not(.is-primary):not(.is-quiet):not(.is-danger):not(.is-google)',
    ]) {
      const control = page.locator(`#main ${selector}, main ${selector}, ${selector}`).first();
      await expect(control).toHaveCSS('border-top-color', controlEdge[theme]);
    }
  });
}
