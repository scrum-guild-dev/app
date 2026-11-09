// 760px 以下の枠の帯（#993）。幅 390px で、パンくずの今の画面の名前が欠けずにアカウントのボタンと重ならないこと、メニューの帯が
// 今のページの項目を見える位置まで送り続きの端に印を付けること、本文が今より上から始まることを、3つのテーマで確かめる。
// ワークスペースの札から一覧を開くのは e2e/workspace-switcher.test.ts、虫眼鏡から検索を開くのは e2e/nav-search.test.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。読むだけにし、seed の行もテーマも書き換えない
import { expect, test } from './fixtures.ts';
import { applyTheme, LAYOUT_THEMES, NARROW_VIEWPORT, signIn } from './helpers.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

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
    const current = page.locator('.breadcrumb [aria-current="page"]');
    await expect(current).toHaveText(name);
    await page.waitForLoadState('networkidle');
    for (const theme of LAYOUT_THEMES) {
      await applyTheme(page, theme);
      const result = await page.evaluate(async () => {
        await document.fonts.ready;
        const item = document.querySelector<HTMLElement>('.breadcrumb [aria-current="page"]')!;
        const account = document.querySelector('.account-menu-button')!.getBoundingClientRect();
        const nav = document.getElementById('app-nav')!;
        const box = nav.getBoundingClientRect();
        const link = nav.querySelector('a.nav-item[aria-current="page"]')!.getBoundingClientRect();
        return {
          clipped: item.scrollWidth > item.clientWidth,
          gap: account.left - item.getBoundingClientRect().right,
          linkInStrip: link.left >= box.left - 0.5 && link.right <= box.right + 0.5,
          scrollable: nav.scrollWidth > nav.clientWidth,
          marked: nav.hasAttribute('data-more-start') || nav.hasAttribute('data-more-end'),
          contentTop: document.getElementById('content')!.getBoundingClientRect().top,
        };
      });
      expect(result.clipped, `${theme}: 今の画面の名前が省略される`).toBe(false);
      expect(result.gap, `${theme}: 今の画面の名前がアカウントのボタンに重なる`).toBeGreaterThanOrEqual(0);
      expect(result.linkInStrip, `${theme}: 今のページの項目が帯の外にある`).toBe(true);
      if (result.scrollable) expect(result.marked, `${theme}: 続きがある端に印が無い`).toBe(true);
      // 以前は y≈324〜340（ロゴ、組織、メニュー、パンくずとアカウント、検索の5段）。いまは約 205px。書体の差に余裕を持たせる
      expect(result.contentTop, `${theme}: 本文の始まり`).toBeLessThanOrEqual(230);
    }
  });
}

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
