import { openCatalog } from './design-samples.ts';
import { expect, test } from './fixtures.ts';

const THEMES = ['simple_light', 'simple_dark', 'modern'] as const;

// 幅ごとに1件にし、テーマはページを開いたまま切り替えて確かめる（カタログを読み直すのは幅ごとに1回。テーマごとに分けると
// 18 回読み直して e2e で2番目に重いファイルになっていた）。どのテーマで落ちたかは test.step の名前で分かる
export function testCatalogNavWrapping(width: number): void {
  test(`長い名前のメニューの見本: ${width}px / 3つのテーマ`, async ({ page }) => {
    // 3テーマの比較と既存幅との再比較は、CIのtraceで合計30秒近く掛かる。各検査の待ちは増やさず、全体に余裕を持たせる。
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 1000 });
    const errors = await openCatalog(page);
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
    const pickTheme = async (theme: (typeof THEMES)[number]) => {
      await page.locator(`[data-pick-theme][value="${theme}"]`).check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    };
    // テーマごとの、見本の節があるときのページの幅
    const pageWidths = new Map<string, number>();
    for (const theme of THEMES) {
      await test.step(theme, async () => {
        await pickTheme(theme);
        // 余白の段を実際に描き、入力欄とラベルが同じ刻みで配置されることを幅・テーマごとに確かめる。
        const spacing = page.locator('#space .space-row');
        await expect(spacing).toHaveCount(9);
        expect(
          await spacing.locator('i').evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().width)),
        ).toEqual([2, 4, 8, 12, 16, 20, 24, 32, 40]);
        const field = page.locator('#forms .field').filter({ has: page.locator('#f1') });
        await expect(field).toHaveCSS('gap', '4px');
        await expect(page.locator('#f1')).toHaveCSS('padding-top', '8px');
        await expect(page.locator('#f1')).toHaveCSS('padding-left', '12px');
        const smallButton = page.locator('#buttons .btn.is-sm').first();
        await expect(smallButton).toHaveCSS('padding-top', '4px');
        await expect(smallButton).toHaveCSS('padding-left', '12px');
        // 通常のボタン・選択欄と入力欄を並べるとき、マウス向けでも高さが大きくずれない。
        const heights = await page.evaluate(() => {
          const height = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
          return { input: height('#f1'), button: height('#buttons .btn'), select: height('#f0') };
        });
        expect(Math.abs(heights.input - heights.button)).toBeLessThanOrEqual(6);
        expect(Math.abs(heights.input - heights.select)).toBeLessThanOrEqual(6);
        const loadingCode = page.locator('pre').filter({ hasText: 'LoadingSheet の中身' });
        await expect(loadingCode).toBeVisible();
        const codeBox = await loadingCode.boundingBox();
        expect(codeBox!.x).toBeGreaterThanOrEqual(0);
        expect(codeBox!.x + codeBox!.width).toBeLessThanOrEqual(width + 1);
        for (const [index, nav] of (await section.locator('.nav').all()).entries()) {
          await nav.scrollIntoViewIfNeeded();
          // テーマを当てた後のスタイルと寸法は同期で決まるので、メニュー1つ分を1回の evaluate でまとめて読む
          // （項目ごとに待ちつきの確かめを並べると、大きなカタログの上で1回ずつ要素を引き直し、テーマごとに数秒かかっていた）
          const read = await nav.evaluate((el) => {
            const label = el.querySelector<HTMLElement>('.is-wrapping .nav-item-label')!;
            const rect = label.getBoundingClientRect();
            const item = label.parentElement!.getBoundingClientRect();
            return {
              display: getComputedStyle(el).display,
              icons: el.querySelectorAll('svg use').length,
              // 元の locator の確かめと同じく、当たる要素がちょうど1つであることも見る（querySelector は最初の1つしか読まない）
              currents: el.querySelectorAll('[aria-current="page"]').length,
              labels: el.querySelectorAll('.is-wrapping .nav-item-label').length,
              currentIsWrapping: el.querySelector('[aria-current="page"]')?.classList.contains('is-wrapping') ?? false,
              overflowWrap: getComputedStyle(label).overflowWrap,
              width: rect.width,
              scroll: label.scrollWidth,
              height: rect.height,
              lineHeight: parseFloat(getComputedStyle(label).lineHeight),
              clientHeight: label.clientHeight,
              scrollHeight: label.scrollHeight,
              left: rect.left,
              right: rect.right,
              itemLeft: item.left,
              itemRight: item.right,
              navWidth: el.clientWidth,
              navContent: el.scrollWidth,
            };
          });
          expect(read.display).toBe('grid');
          expect(read.icons).toBe(3);
          expect(read.currents).toBe(1);
          expect(read.labels).toBe(1);
          expect(read.currentIsWrapping).toBe(true);
          expect(read.overflowWrap).toBe('anywhere');
          expect(read.scroll).toBeLessThanOrEqual(read.width + 1);
          expect(read.left).toBeGreaterThanOrEqual(read.itemLeft);
          expect(read.right).toBeLessThanOrEqual(read.itemRight + 1);
          if (width > 760 && index > 0) expect(read.height).toBeGreaterThanOrEqual(read.lineHeight * 2 - 1);
          expect(read.scrollHeight).toBeLessThanOrEqual(read.clientHeight + 1);
          expect(read.navContent).toBeLessThanOrEqual(read.navWidth + 1);
          // 縦のメニューなので、横に送らず最後の項目まで読める
          await nav.evaluate((el) => {
            el.scrollLeft = el.scrollWidth;
          });
          await expect(nav.locator('.nav-item').last()).toBeInViewport();
          await nav.evaluate((el) => {
            el.scrollLeft = 0;
          });
        }
        const bounds = await section.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        pageWidths.set(theme, await page.evaluate(() => document.documentElement.scrollWidth));
      });
    }
    // 見本の節が幅を増やさないことを、節を消した後の幅とテーマごとに比べて確かめる（カタログ全体が 320px ではみ出さないことは、design-catalog-layout.test.ts で見る）。
    await section.evaluate((el) => el.remove());
    for (const theme of THEMES) {
      await pickTheme(theme);
      const existingWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidths.get(theme), theme).toBeLessThanOrEqual(Math.max(width, existingWidth));
    }
    expect(errors).toEqual([]);
  });
}
