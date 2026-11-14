import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.ts';

const THEMES = ['simple_light', 'simple_dark', 'modern'] as const;

// 幅ごとに1件にし、テーマはページを開いたまま切り替えて確かめる（カタログを読み直すのは幅ごとに1回。テーマごとに分けると
// 18 回読み直して e2e で2番目に重いファイルになっていた）。どのテーマで落ちたかは test.step の名前で分かる
for (const width of [1280, 1024, 761, 760, 390, 320]) {
  test(`長い名前のメニューの見本: ${width}px / 3つのテーマ`, async ({ page }) => {
    // 3テーマの比較と既存幅との再比較は、CIのtraceで合計30秒近く掛かる。各検査の待ちは増やさず、全体に余裕を持たせる。
    test.setTimeout(60_000);
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
    const pickTheme = async (theme: (typeof THEMES)[number]) => {
      await page.locator(`[data-pick-theme][value="${theme}"]`).check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    };
    // テーマごとの、見本の節があるときのページの幅
    const pageWidths = new Map<string, number>();
    for (const theme of THEMES) {
      await test.step(theme, async () => {
        await pickTheme(theme);
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
    // 他の既存の見本は 320/390px で横にはみ出す。今回の見本が幅を増やさないことを、節を消した後の幅とテーマごとに比べて確かめる。
    await section.evaluate((el) => el.remove());
    for (const theme of THEMES) {
      await pickTheme(theme);
      const existingWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidths.get(theme), theme).toBeLessThanOrEqual(Math.max(width, existingWidth));
    }
    expect(errors).toEqual([]);
  });
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
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('[data-assist-open]').first()).toBeHidden();
  await expect(page.locator('.mobile-page-tools')).toBeVisible();
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
  // スマホでは検索とアカウントだけを出すので、見本のアシスタントの操作は広い幅へ戻して確かめる。
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(drawer.locator('#new-comment')).toHaveValue('書きかけのコメント');
  await page.locator('[data-assist-open]').first().focus();
  await page.keyboard.press('Enter');
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
  modern: 'rgb(70, 115, 159)',
};
// カタログを開くのは1回にし、テーマはページを開いたまま切り替える（テーマごとに開き直さない）。どのテーマで落ちたかは test.step の名前で分かる
test('操作部品の枠の色: 3つのテーマ', async ({ page }) => {
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
});

test('見本のカタログ: 「ストーリーを直す（引き出し）」の入口は、本物の引き出しを開き、カタログの節を壊さない', async ({
  page,
}) => {
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
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/__design-catalog/index.html');
  const section = page.locator('#task-drawer');
  const before = await section.locator('.cat-drawer').count();
  expect(before).toBeGreaterThan(0);
  await page.locator('a[data-story-can-delete="false"]').click();
  const drawer = page.locator('aside#drawer');
  await expect(drawer).toBeVisible();
  // 削除できない人の形: 「⋯」に削除は無く、理由が本文の下に出る
  await expect(drawer.getByText('削除できるのは作った人とリーダーです。')).toBeVisible();
  await drawer.locator('.row-menu-btn').click();
  await expect(drawer.locator('.row-menu-list .menu-item')).toHaveText(['親を移す']);
  await page.keyboard.press('Escape');
  await expect(section.locator('.cat-drawer')).toHaveCount(before);
  expect(errors).toEqual([]);
});

test('見本の削除の確認: クリア済みのエピックを配下を残して削除すると断られ、確認は閉じない', async ({ page }) => {
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
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/__design-catalog/index.html');
  const dialog = page.locator('#dialog');

  // まとめて削除できる人: 「残す」は最初から選べず、理由が出る。どちらも未選択で、選ぶまで押せず、選ぶと閉じられる
  await page.locator('[data-dialog="deleteEpicCleared"]').click();
  await expect(dialog.getByLabel('配下を親なしで残す')).toBeDisabled();
  await expect(dialog.getByLabel('配下もまとめて削除する')).not.toBeChecked();
  await expect(dialog.locator('.btn.is-danger')).toHaveAttribute('aria-disabled', 'true');
  await dialog.locator('.btn.is-danger').click({ force: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('配下もまとめて削除する').check();
  await expect(dialog.getByLabel('配下を親なしで残す')).toHaveAccessibleDescription(
    /「配下もまとめて削除する」を選ぶか、先に/,
  );
  await dialog.locator('.btn.is-danger').click();
  await expect(dialog).toBeHidden();

  // まとめて削除できない人: どちらも選べず、依頼主かリーダーに頼む文が出て、削除するは押せない
  await page.locator('[data-dialog="deleteEpicClearedLeaderOnly"]').click();
  await expect(dialog.getByLabel('配下を親なしで残す')).toBeDisabled();
  await expect(dialog.getByLabel('配下もまとめて削除する')).toBeDisabled();
  await expect(dialog.getByLabel('配下を親なしで残す')).toHaveAccessibleDescription(
    /に、エピックの完了を取り消してもらってください/,
  );
  await expect(dialog.locator('.btn.is-danger')).toHaveAttribute('aria-disabled', 'true');
  await dialog.locator('.btn.is-danger').click({ force: true });
  await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
});

test('スマホの見本の浮きメニューから組織作成を開ける（#1102）', async ({ page }) => {
  const files: Record<string, string> = {
    'today.html': 'text/html',
    'tokens.css': 'text/css',
    'components.css': 'text/css',
    'icons.js': 'text/javascript',
    'art.js': 'text/javascript',
    'sample-data.js': 'text/javascript',
    'kit.js': 'text/javascript',
  };
  await page.route('**/__design-mobile/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop()!;
    if (!files[file]) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({
      contentType: files[file],
      body: readFileSync(new URL(`../design/${file}`, import.meta.url)),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__design-mobile/today.html');
  await page.getByRole('button', { name: 'すべてのメニュー', exact: true }).click();
  const menu = page.locator('#mobile-menu');
  await expect(menu.getByRole('heading', { name: 'メニュー', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: '閉じる', exact: true })).toBeVisible();
  await menu.locator('.org-menu-button').click();
  await menu.locator('[data-dialog="createMyOrganization"]').click();
  await expect(menu).toBeHidden();
  const create = page.locator('#dialog input').first();
  await expect(create).toBeFocused();
  await create.fill('こもれび工房');
  await expect(create).toHaveValue('こもれび工房');
});
