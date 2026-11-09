// 760px 以下の枠の帯（#993）。幅 390px で、パンくずの今の画面の名前が欠けずにアカウントのボタンと重ならないこと、メニューの帯が
// 今のページの項目を見える位置まで送り続きの端に印を付けること、本文が今より上から始まることを、3つのテーマで確かめる。
// ワークスペースの札から一覧を開くのは e2e/workspace-switcher.test.ts、虫眼鏡から検索を開くのは e2e/nav-search.test.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。読むだけにし、seed の行もテーマも書き換えない
import type { Page } from '@playwright/test';
import { NAV_STRIP_PEEK } from '../src/lib/nav-strip.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { expect, test } from './fixtures.ts';
import { applyTheme, LAYOUT_THEMES, NARROW_VIEWPORT, signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 今の画面の名前、アカウントのボタン、メニューの帯、本文の位置を測る
async function measureFrame(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    // 書体やテーマで項目の幅が変わると、帯（NavMenu の ResizeObserver）が描く前に送り直す。2 フレーム待ってから測る
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // 端の幕の幅は、帯に当たった CSS の値（components.css の --nav-strip-peek）から読む。送り位置の peek（src/lib/nav-strip.ts の
    // NAV_STRIP_PEEK、32px）とずれると、今の項目が幕にかかってこの確かめが落ちる
    const peek = parseFloat(getComputedStyle(document.getElementById('app-nav')!).getPropertyValue('--nav-strip-peek'));
    const item = document.querySelector<HTMLElement>('.breadcrumb [aria-current="page"]')!;
    // 省略記号が出たかは、文字の幅と箱の幅で比べる。scrollWidth と clientWidth は整数に丸めるので、1px 未満の縮みを拾えない
    const range = document.createRange();
    range.selectNodeContents(item);
    const crumb = document.querySelector('.breadcrumb')!.getBoundingClientRect();
    const account = document.querySelector('.account-menu-button')!.getBoundingClientRect();
    const nav = document.getElementById('app-nav')!;
    const box = nav.getBoundingClientRect();
    const link = nav.querySelector('a.nav-item[aria-current="page"]')!.getBoundingClientRect();
    const more = { start: nav.hasAttribute('data-more-start'), end: nav.hasAttribute('data-more-end') };
    return {
      peek,
      clipped: range.getBoundingClientRect().width > item.getBoundingClientRect().width + 0.01,
      gap: account.left - item.getBoundingClientRect().right,
      sameRow: Math.abs(account.top + account.height / 2 - (crumb.top + crumb.height / 2)) < 12,
      linkInStrip: link.left >= box.left - 0.5 && link.right <= box.right + 0.5,
      // 続きがある側の端には幕が重なるので、今の項目はその幅の内側にある
      clearOfFade:
        (!more.start || link.left >= box.left + peek - 0.5) && (!more.end || link.right <= box.right - peek + 0.5),
      scrollable: nav.scrollWidth > nav.clientWidth,
      more,
      contentTop: document.getElementById('content')!.getBoundingClientRect().top,
    };
  });
}

for (const [path, name] of [
  [WORKSPACE, 'バックログ'],
  [`${WORKSPACE}/inbox`, '受信箱'],
  [`${WORKSPACE}/wiki`, 'Wiki'],
  [`${WORKSPACE}/settings`, '設定'],
] as const) {
  test(`390px の ${name} で、パンくずの今の画面の名前が読め、今のページの項目が帯に見え、本文が上から始まる`, async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto(path);
    await expect(page.locator('.breadcrumb [aria-current="page"]')).toHaveText(name);
    await page.waitForLoadState('networkidle');
    for (const theme of LAYOUT_THEMES) {
      // テーマを替えると書体が替わって項目の幅が変わり、帯（NavMenu の ResizeObserver）が送り位置を測り直す。測り直した後を見る
      await applyTheme(page, theme);
      const result = await measureFrame(page);
      expect(result.clipped, `${theme}: 今の画面の名前が省略される`).toBe(false);
      expect(result.gap, `${theme}: 今の画面の名前がアカウントのボタンに重なる`).toBeGreaterThanOrEqual(0);
      expect(result.sameRow, `${theme}: アカウントのボタンがパンくずの行に無い`).toBe(true);
      expect(result.linkInStrip, `${theme}: 今のページの項目が帯の外にある`).toBe(true);
      // 幕の幅を読めないと（変数の名前が変わった、など）、幕にかかるかの確かめが空振りする
      expect(result.peek, `${theme}: 幕の幅（--nav-strip-peek）`).toBe(NAV_STRIP_PEEK);
      expect(result.clearOfFade, `${theme}: 今のページの項目が端の幕にかかる`).toBe(true);
      // ワークスペースの項目は 390px の帯からはみ出し、今の項目まで送るので、左に続きがある（右は、末尾の設定では無い）
      expect(result.scrollable, `${theme}: 帯がはみ出していない`).toBe(true);
      expect(result.more.start, `${theme}: 左の続きの印が無い`).toBe(true);
      // 以前は y≈324〜340（ロゴ、組織、メニュー、パンくずとアカウント、検索の5段）。いまは約 205px。書体の差に余裕を持たせる
      expect(result.contentTop, `${theme}: 本文の始まり`).toBeLessThanOrEqual(230);
    }
  });
}

test('390px の今日やることでは、帯は先頭のままで、右にだけ続きの印が付く', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/aoba');
  await page.waitForLoadState('networkidle');
  const result = await measureFrame(page);
  expect(result.linkInStrip).toBe(true);
  expect(result.clearOfFade).toBe(true);
  expect(result.more).toEqual({ start: false, end: true });
});

test('390px で所属していない管理者がワークスペースを開いても、アカウントのボタンはパンくずの行に残る', async ({
  page,
}) => {
  // 所属していない管理者の印（.topbar の直接の子の .chip）は幅があり、パンくずの行に並べるとアカウントを2行目へ押し出す
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({ ...output, role: null }));
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  await expect(page.locator('.topbar > .chip')).toHaveText('所属せず管理者として開いています');
  await page.waitForLoadState('networkidle');
  const result = await measureFrame(page);
  expect(result.sameRow).toBe(true);
  expect(result.clipped).toBe(false);
  expect(result.gap).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('390px でアカウントのボタンはアバターと▾だけで、読み上げの名前に表示名を残す', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  const button = page.getByRole('button', { name: /ミナト.*アカウントのメニュー/ });
  await expect(button).toBeVisible();
  await expect(button.locator('.me-detail')).toBeHidden();
  await expect(button.locator('.avatar')).toBeVisible();
});

test('761px 以上では虫眼鏡を出さず、検索の欄と表示名を帯に出す', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(WORKSPACE);
  await expect(page.getByRole('combobox', { name: '画面とタスクを探す' })).toBeVisible();
  await expect(page.locator('.nav-search-toggle')).toBeHidden();
  await expect(page.locator('.account-menu-button .me-detail')).toBeVisible();
});
