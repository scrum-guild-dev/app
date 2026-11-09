// #1040: 骨組みの退場と、中身が同時に出てもレイアウトを押し下げないこと。
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { backlogTree } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { expectNoA11yViolationsInThemes, signIn } from './helpers.ts';
import { routeOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`直接開いた骨組みは中身の描画後に消える（${reducedMotion}）`, async ({ page, context, baseURL }) => {
    await page.emulateMedia({ reducedMotion });
    await signIn(context, baseURL, 'admin');
    await page.addInitScript(() => {
      const seen = {
        leaving: false,
        content: false,
        duration: '',
        hidden: false,
        frame: false,
        opacity: [] as string[],
      };
      Object.assign(window, { __bootFade: seen });
      new MutationObserver(() => {
        const boot = document.querySelector<HTMLElement>('#boot-loading.is-leaving');
        if (!boot) return;
        seen.leaving = true;
        seen.frame =
          document.documentElement.dataset.boot === 'tree' &&
          getComputedStyle(boot.querySelector('.boot-frame')!).display !== 'none';
        seen.content = document.querySelector('#app h1') !== null;
        seen.duration = getComputedStyle(boot).transitionDuration;
        if (!seen.opacity.length)
          seen.opacity = boot
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
            .flatMap((animation) =>
              animation.effect instanceof KeyframeEffect
                ? animation.effect.getKeyframes().map((frame) => String(frame.opacity))
                : [],
            );
        seen.hidden = boot.inert && boot.getAttribute('aria-hidden') === 'true';
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
      await gate;
      await call.passThrough();
    });
    await page.goto(WORKSPACE, { waitUntil: 'commit' });
    await expect(page.locator('#boot-loading')).toBeVisible();
    release();
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#boot-loading')).toHaveCount(0);
    const seen = await page.evaluate(
      () =>
        (
          window as unknown as {
            __bootFade: {
              leaving: boolean;
              content: boolean;
              duration: string;
              hidden: boolean;
              frame: boolean;
              opacity: string[];
            };
          }
        ).__bootFade,
    );
    expect(seen.leaving).toBe(reducedMotion === 'no-preference');
    await expect(page.locator('html')).not.toHaveAttribute('data-boot');
    await expect(page.locator('html')).not.toHaveAttribute('data-boot-nav');
    if (reducedMotion === 'no-preference') {
      expect(seen.content).toBe(true);
      expect(seen.duration).toBe('0.12s');
      expect(seen.frame).toBe(true);
      expect(seen.opacity).toEqual(['1', '0']);
      expect(seen.hidden).toBe(true);
    }
  });

  test(`組織への移動の紙は重ねて消える（${reducedMotion}）`, async ({ page, context, baseURL }) => {
    // 4テーマの axe は開発用ビルドでも最後まで検査する。フェードの時間の期待値は120msのまま。
    if (reducedMotion === 'no-preference') test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion });
    await signIn(context, baseURL, 'admin');
    await page.goto('/');
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
      await gate;
      const body = await call.fetch();
      body.organization.theme = 'modern';
      await call.fulfill(body);
    });
    await page.evaluate(() => {
      const seen = { duration: -1, fixed: false, contentTop: -1, hidden: false, shape: '', opacity: [] as number[] };
      Object.assign(window, { __sheetFade: seen });
      new MutationObserver(() => {
        const overlay = document.querySelector<HTMLElement>('.loading-overlay.is-leaving');
        const heading = document.querySelector('h1:not(.visually-hidden)');
        if (!overlay || !heading) return;
        const style = getComputedStyle(overlay);
        seen.duration = parseFloat(style.transitionDuration) * 1000;
        if (!seen.opacity.length)
          seen.opacity = overlay
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
            .flatMap((animation) =>
              animation.effect instanceof KeyframeEffect
                ? animation.effect.getKeyframes().map((frame) => Number(frame.opacity))
                : [],
            );
        seen.shape = overlay.querySelector('[data-shape]')?.getAttribute('data-shape') ?? '';
        seen.fixed = style.position === 'fixed';
        seen.hidden = overlay.inert && overlay.getAttribute('aria-hidden') === 'true';
        seen.contentTop = heading.getBoundingClientRect().top;
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await page.getByRole('link', { name: /あおば開発/ }).click();
    await expect(page.locator('.loading-overlay .skeleton-frame')).toBeVisible();
    release();
    const heading = page.getByRole('heading', { level: 1, name: '今日やること' });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.loading-overlay')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'modern');
    const seen = await page.evaluate(
      () =>
        (
          window as unknown as {
            __sheetFade: {
              duration: number;
              fixed: boolean;
              contentTop: number;
              hidden: boolean;
              shape: string;
              opacity: number[];
            };
          }
        ).__sheetFade,
    );
    if (reducedMotion === 'no-preference') {
      expect(seen.duration).toBe(120);
      expect(seen.opacity[0]).toBe(1);
      expect(seen.opacity.at(-1)).toBe(0);
      expect(seen.fixed).toBe(true);
      expect(seen.shape).toBe('today');
      expect(seen.hidden).toBe(true);
      expect(seen.contentTop).toBeCloseTo((await heading.boundingBox())!.y, 0);
      await expectNoA11yViolationsInThemes(page, 'today');
    } else {
      expect(seen.duration).toBeLessThanOrEqual(0);
    }
  });
}

for (const mode of ['hidden', 'missing-transitionend'] as const) {
  test(`最初の骨組みを残さない（${mode}）`, async ({ page, context, baseURL }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await signIn(context, baseURL, 'admin');
    if (mode === 'hidden') {
      // 実行環境の速さによらず、300ms より前と同じ「まだ非表示」の分岐を通す。
      await page.route('**/boot-loading.css', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('linear 300ms', 'linear 86400s') });
      });
    }
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
      await gate;
      await call.passThrough();
    });
    await page.goto(WORKSPACE, { waitUntil: 'commit' });
    const boot = page.locator('#boot-loading');
    await expect(boot).toBeAttached();
    if (mode === 'hidden') await expect(boot).toBeHidden();
    else await expect(boot).toBeVisible();
    await page.evaluate(() => {
      const boot = document.querySelector('#boot-loading')!;
      const seen = { leaving: false, started: 0, elapsed: 0 };
      Object.assign(window, { __bootRemoval: seen });
      boot.addEventListener('transitionend', (event) => event.stopImmediatePropagation(), true);
      new MutationObserver(() => {
        if (boot.classList.contains('is-leaving') && !seen.leaving) {
          seen.leaving = true;
          seen.started = performance.now();
        }
        if (!boot.isConnected && seen.started && !seen.elapsed) seen.elapsed = performance.now() - seen.started;
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    release();
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible({ timeout: 15_000 });
    await expect(boot).toHaveCount(0);
    const seen = await page.evaluate(
      () => (window as unknown as { __bootRemoval: { leaving: boolean; elapsed: number } }).__bootRemoval,
    );
    expect(seen.leaving).toBe(mode === 'missing-transitionend');
    if (mode === 'missing-transitionend') expect(seen.elapsed).toBeGreaterThanOrEqual(180);
  });
}

test('移動中に行き先の形が変わっても骨組みを消して出し直さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/');
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await routeOperation(page, organizationInfo, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.passThrough();
  });
  await page.getByRole('link', { name: /あおば開発/ }).click();
  await expect(page.locator('.loading-overlay .skeleton-frame')).toHaveAttribute('data-shape', 'today');
  await page.evaluate(() => {
    const original = document.querySelector('.loading-overlay')!;
    const seen = { original, left: false };
    Object.assign(window, { __redirectLoading: seen });
    new MutationObserver(() => {
      if (original.classList.contains('is-leaving')) seen.left = true;
    }).observe(document.body, { attributes: true, subtree: true });
  });
  try {
    // 同じ外側の画面から、先の読み込みが終わる前に別の行き先へ移る。
    await page.evaluate((href) => {
      const link = document.createElement('a');
      link.href = href;
      document.body.append(link);
      link.click();
      link.remove();
    }, WORKSPACE);
    await expect(page.locator('.loading-overlay .skeleton-frame')).toHaveAttribute('data-shape', 'tree');
    const kept = await page.evaluate(() => {
      const seen = (window as unknown as { __redirectLoading: { original: Element; left: boolean } }).__redirectLoading;
      return seen.original.isConnected && document.querySelector('.loading-overlay') === seen.original && !seen.left;
    });
    expect(kept).toBe(true);
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.loading-overlay')).toHaveCount(0);
});
