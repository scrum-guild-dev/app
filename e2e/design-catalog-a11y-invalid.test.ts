import { expectAccessibleCatalog, openCatalogSections } from './design-catalog-a11y.ts';
import { routeDesignCatalog } from './design-samples.ts';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme } from './helpers.ts';

// 各 assertion の待ちは延ばさず、カタログ全体の axe 検査は60秒以内で確かめる。
test.setTimeout(60_000);

for (const [name, body] of [
  ['目次が空', '<main id="main"></main>'],
  [
    '目次の参照先が不正',
    '<nav id="toc"><a href="other.html">見本</a></nav><main id="main"><section class="cat-block" id="one">見本</section></main>',
  ],
  [
    '目次とセクションが対応しない',
    '<nav id="toc"><a href="#missing">見本</a></nav><main id="main"><section class="cat-block" id="one">見本</section></main>',
  ],
  [
    '目次の参照先が重複する',
    '<nav id="toc"><a href="#one">見本1</a><a href="#one">見本2</a></nav><main id="main"><section class="cat-block" id="one">見本1</section><section class="cat-block" id="one">見本2</section></main>',
  ],
  [
    'セクションが非表示',
    '<nav id="toc"><a href="#one">見本</a></nav><main id="main"><section class="cat-block" id="one" hidden>見本</section></main>',
  ],
]) {
  test(`カタログの表示確認は${name}なら失敗する`, async ({ page }) => {
    // 後から登録する差し替えのルートを優先する。
    await routeDesignCatalog(page);
    await page.route('**/__design-catalog/index.html', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>デザインシステム</h1>${body}` }),
    );
    await expect(openCatalogSections(page)).rejects.toThrow(name);
  });
}

test('壊したカタログの無名ボタンと低コントラスト文字で、検査が落ちる', async ({ page }) => {
  const errors = await openCatalogSections(page);
  await applyTheme(page, A11Y_THEMES[0]);
  await page.locator('#main').evaluate((main) => {
    const broken = document.createElement('div');
    broken.innerHTML =
      '<button type="button" id="broken-button"></button>' +
      '<p id="broken-contrast" style="color:#999;background:#aaa">Faint text</p>';
    main.prepend(broken);
  });
  // 別の既存違反による失敗では足りず、仕込んだ2つを検査の入口が報告することを確かめる。
  const checked = expectAccessibleCatalog(page);
  await expect(checked).rejects.toThrow(/- button-name: #broken-button/);
  await expect(checked).rejects.toThrow(/- color-contrast: #broken-contrast/);
  expect(errors).toEqual([]);
});
