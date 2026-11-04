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
