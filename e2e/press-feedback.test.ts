import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, findA11yViolations, NARROW_VIEWPORT } from './helpers.ts';

for (const path of ['/login', '/signup']) {
  for (const provider of ['github', 'google']) {
    test(`${path}: ${provider} への移動を知らせ、連打を止め、戻ったら復元する`, async ({ page }) => {
      await page.setViewportSize(NARROW_VIEWPORT);
      const links = page.locator('a[data-sveltekit-reload][href^="/api/auth/"]');
      const selected = links.filter({ has: page.locator(provider === 'github' ? '.ico' : '.google-mark') });
      // ページのハンドラーの後で実際の外部移動だけを止め、既定動作が許された回数を見る。
      await page.addInitScript(() => {
        const results: boolean[] = [];
        Object.assign(window, { pressResults: results });
        window.addEventListener('click', (event) => {
          if (!(event.target instanceof Element) || !event.target.closest('a[href^="/api/auth/"]')) return;
          results.push(event.defaultPrevented);
          event.preventDefault();
        });
      });
      await page.goto(path);
      // 別タブの操作は、元の画面を待機中にしない。
      await selected.click({ modifiers: ['Control'] });
      await expect(selected).not.toHaveText('移っています');
      await expect(selected).toHaveAttribute('aria-disabled', 'false');
      await selected.focus();
      await page.keyboard.press('Enter');
      await expect(selected).toHaveText('移っています');
      for (const link of await links.all()) await expect(link).toHaveAttribute('aria-disabled', 'true');
      // aria-disabled のリンクをプログラムから押して、ハンドラーによる防止を確かめる。
      await links.evaluateAll((elements) => elements.forEach((element) => (element as HTMLAnchorElement).click()));
      expect(await page.evaluate(() => Reflect.get(window, 'pressResults'))).toEqual([false, false, true, true]);
      // root は bfcache 復元時に現在のセッションで読み直す。テストの監視も新しい文書へ登録し直す。
      const reloaded = page.waitForEvent('load');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await reloaded;
      await expect(selected).not.toHaveText('移っています');
      for (const link of await links.all()) await expect(link).toHaveAttribute('aria-disabled', 'false');
      for (const theme of A11Y_THEMES) {
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        expect(await findA11yViolations(page)).toEqual([]);
      }
      await selected.evaluate((element) => (element as HTMLAnchorElement).click());
      await expect(selected).toHaveText('移っています');
      expect(await page.evaluate(() => Reflect.get(window, 'pressResults'))).toEqual([false]);
    });
  }
}

for (const [reducedMotion, forcedColors] of [
  ['no-preference', 'none'],
  ['reduce', 'none'],
  ['reduce', 'active'],
] as const) {
  test(`押下中だけ濃淡が変わり、押せない部品は変わらない: ${reducedMotion} / ${forcedColors}`, async ({ page }) => {
    // 本番と見本が共有する CSS を、操作の副作用の無い部品に当てる。
    await page.route('**/__press-feedback', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<style>${readFileSync(new URL('../design/tokens.css', import.meta.url), 'utf8')}
${readFileSync(new URL('../design/components.css', import.meta.url), 'utf8')}</style>
          <button class="btn">標準</button><button class="btn is-primary">主</button>
          <button class="btn is-quiet">控えめ</button><button class="btn is-danger">削除</button>
          <button class="btn is-google">Google</button><button class="btn is-on">選択中</button>
          <button class="done-btn" aria-label="完了">✓</button>
          <button class="chip chip-btn">担当</button><button class="chip chip-btn is-unset">未設定</button>
          <button class="pill">通知</button><button class="pill" aria-pressed="true">選択済み</button>
          <button class="chip chip-btn" aria-disabled="true">変更不可</button>
          <button class="btn" disabled>無効</button><button class="btn" aria-disabled="true">待機</button>`,
      }),
    );
    await page.emulateMedia({ reducedMotion, forcedColors });
    await page.goto('/__press-feedback');
    for (const theme of A11Y_THEMES) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      for (const button of await page.locator('button').all()) {
        await button.hover();
        await button.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        const before = await button.evaluate((element) => ({
          shadow: getComputedStyle(element).boxShadow,
          outline: getComputedStyle(element).outline,
          background: getComputedStyle(element).backgroundImage,
          backgroundColor: getComputedStyle(element).backgroundColor,
          color: getComputedStyle(element).color,
          border: getComputedStyle(element).borderTopColor,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }));
        await page.mouse.down();
        const disabled = await button.evaluate(
          (element) => (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true',
        );
        const property = forcedColors === 'active' ? 'outline' : 'box-shadow';
        const previous = forcedColors === 'active' ? before.outline : before.shadow;
        if (disabled) await expect(button).toHaveCSS(property, previous);
        else await expect(button).not.toHaveCSS(property, previous);
        await expect(button).toHaveCSS('background-image', before.background);
        await expect(button).toHaveCSS('background-color', before.backgroundColor);
        await expect(button).toHaveCSS('color', before.color);
        await expect(button).toHaveCSS('border-top-color', before.border);
        await expect(button).toHaveCSS('transform', 'none');
        const during = await button.boundingBox();
        expect(during!.width).toBe(before.width);
        expect(during!.height).toBe(before.height);
        await page.mouse.up();
        await expect(button).toHaveCSS(property, previous);
      }
    }
  });
}
