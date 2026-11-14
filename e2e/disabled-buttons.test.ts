import { readFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { listOrganizations } from '../src/shared/operations/operator/list-organizations.ts';
import { organizationSuspend } from '../src/shared/operations/operator/organization-suspend.ts';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { consentStatus } from '../src/shared/operations/session/consent.ts';
import { expect, test } from './fixtures.ts';
import { A11Y_THEMES, applyTheme, expectNoA11yViolationsInThemes, signIn } from './helpers.ts';
import { mockOperation, routeOperation } from './operations.ts';

// axe は無効なボタンの文字をコントラスト検査から外すため、実際の描画色も測る。
test('押せない同意ボタンは4テーマと狭い幅でも文字が読め、チェック後と区別できる', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'unconsented');
  await mockOperation(page, consentStatus, {
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    latest: null,
    current: false,
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/consent');
  const button = page.getByRole('button', { name: '同意して進む' });
  const checkbox = page.getByRole('checkbox');
  await expect(button).toHaveCSS('transition-property', /opacity/);
  await expect(page.locator('.choice.is-consent')).toHaveCSS('transition-duration', '0.12s, 0.12s');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.mouse.move(0, 0);
      const disabled = await buttonColors(button);
      expect(disabled.ratio, `${theme} ${width}px`).toBeGreaterThanOrEqual(4.5);
      expect(disabled.opacity).toBe('1');
      expect(disabled.border).toBe(disabled.line);
      expect(disabled.filter).toBe('none');
      await button.hover();
      await expect(button).toHaveCSS('background-color', disabled.background);
      await expect(button).toHaveCSS('color', disabled.color);
      await expect(button).toHaveCSS('border-top-color', disabled.line);
      await expect(button).toHaveCSS('filter', 'none');
      await button.evaluate((element) => {
        element.removeAttribute('data-disabled-clicked');
        element.addEventListener('click', () => element.setAttribute('data-disabled-clicked', 'true'), { once: true });
      });
      await button.click({ force: true });
      await expect(button).toHaveAttribute('data-disabled-clicked', 'true');
      await expect(checkbox).not.toBeChecked();
      await expect(page).toHaveURL(/\/consent$/);
      await checkbox.check();
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveCSS('background-color', disabled.accent);
      await expect(button).toHaveCSS('color', disabled.onAccent);
      await checkbox.uncheck();
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await checkbox.check();
  await expect(button).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('.choice.is-consent')).toHaveCSS('transition-duration', '0s');
  await checkbox.uncheck();
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expectNoA11yViolationsInThemes(page, 'consent');
});

async function buttonColors(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const rgb = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
      return rgb.reduce((sum, value, index) => {
        const channel = value / 255;
        return (
          sum +
          (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]
        );
      }, 0);
    };
    const foreground = luminance(style.color);
    // 静かな操作は透明な面を保つので、その下の不透明な面との比を測る。
    const surfaceColor = (start: Element | null) => {
      for (let current = start; current; current = current.parentElement) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)') return color;
      }
      return 'rgb(255, 255, 255)';
    };
    const background = luminance(surfaceColor(element));
    const parentBackground = luminance(surfaceColor(element.parentElement));
    const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const border = luminance(style.borderTopColor);
    const palette = document.createElement('span');
    palette.style.cssText =
      'color:var(--color-accent);background:var(--color-on-accent);border-color:var(--color-line)';
    document.body.append(palette);
    const paletteStyle = getComputedStyle(palette);
    const accent = paletteStyle.color;
    const onAccent = paletteStyle.backgroundColor;
    const line = paletteStyle.borderTopColor;
    palette.remove();
    return {
      ratio: contrast(foreground, background),
      borderRatio: Math.min(contrast(border, background), contrast(border, parentBackground)),
      opacity: style.opacity,
      background: style.backgroundColor,
      color: style.color,
      border: style.borderTopColor,
      filter: style.filter,
      accent,
      onAccent,
      line,
    };
  });
}

test('停止の送信中は危険操作と取り消しの文字が4テーマで読め、ホバーでも色を戻さない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'operator');
  await mockOperation(page, listOrganizations, {
    organizations: [
      {
        slug: 'aoba',
        name: 'あおば開発',
        kind: 'team',
        suspended_at: null,
        purge_on: null,
        purge_due: false,
        created_at: '2026-10-01T09:30:00.000Z',
        admin_status: 'active',
        seats: { used: 5, limit: 15 },
        workspace_count: 3,
        task_count: 1284,
        attachment_quota_bytes: 32212254720,
        attachment_used_bytes: 0,
        last_used_at: '2026-10-20T00:12:00.000Z',
        self_created: false,
        trial_ends_on: null,
        trial_expired: false,
        contract: null,
      },
    ],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeOperation(page, organizationSuspend, async (call) => {
    await gate;
    await call.fail(500, 'internal');
  });
  await page.goto('/operator');
  await page.getByRole('button', { name: '「あおば開発」を停止する' }).click();
  const dialog = page.getByRole('dialog', { name: '組織を停止する' });
  await dialog.getByRole('button', { name: '「あおば開発」を停止する' }).click();
  try {
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const name of ['停止しています', 'やめる']) {
        const button = dialog.getByRole('button', { name });
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await page.mouse.move(0, 0);
        const disabled = await buttonColors(button);
        expect(disabled.ratio, `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(disabled.opacity).toBe('1');
        const border = disabled.line;
        expect(disabled.border).toBe(border);
        if (name === 'やめる') await expect(button).toHaveCSS('border-top-style', 'dashed');
        expect(disabled.filter).toBe('none');
        await button.hover();
        await expect(button).toHaveCSS('color', disabled.color);
        await expect(button).toHaveCSS('background-color', disabled.background);
        await expect(button).toHaveCSS('border-top-color', border);
        await expect(button).toHaveCSS('filter', 'none');
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
  } finally {
    release();
  }
});

// 共通CSSの部品検証。実画面の送信中に加え、選択中と静かな操作のnative/ARIA無効も守る。
test('選択中の無効ボタンは印を残し、静かな無効ボタンは点線で区別し、親の面が違っても文字が読める', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setContent('<main><div id="plate"></div></main>');
  for (const sheet of ['tokens', 'components']) {
    await page.addStyleTag({ content: await readFile(new URL(`../design/${sheet}.css`, import.meta.url), 'utf8') });
  }
  await page.locator('#plate').evaluate((element) => {
    for (const variant of ['is-quiet', 'is-quiet is-danger', 'is-on', 'is-quiet is-on']) {
      for (const aria of [false, true]) {
        const button = document.createElement('button');
        button.className = `btn ${variant}`;
        button.textContent = '操作';
        if (variant.includes('is-on')) button.setAttribute('aria-pressed', 'true');
        if (aria) button.setAttribute('aria-disabled', 'true');
        else button.disabled = true;
        element.append(button);
      }
    }
  });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      for (const surface of ['bg', 'surface', 'sunken']) {
        await page.locator('#plate').evaluate((element, value) => {
          (element as HTMLElement).style.backgroundColor = `var(--color-${value})`;
        }, surface);
        for (const button of await page.locator('#plate .btn').all()) {
          await page.mouse.move(width - 1, 899);
          const disabled = await buttonColors(button);
          const selected = await button.evaluate((element) => element.classList.contains('is-on'));
          const quiet = await button.evaluate((element) => element.classList.contains('is-quiet'));
          const background = !quiet
            ? await button.evaluate((element) => {
                const probe = document.createElement('span');
                probe.style.backgroundColor = 'var(--color-sunken)';
                element.append(probe);
                const color = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return color;
              })
            : 'rgba(0, 0, 0, 0)';
          const border = selected ? disabled.accent : disabled.line;
          const borderStyle = quiet ? 'dashed' : 'solid';
          expect(disabled.ratio, `${theme} ${surface} ${width}px`).toBeGreaterThanOrEqual(4.5);
          expect(disabled.opacity).toBe('1');
          if (selected) expect(disabled.borderRatio, `${theme} ${surface} 選択枠`).toBeGreaterThanOrEqual(3);
          await expect(button).toHaveCSS('background-color', background);
          await expect(button).toHaveCSS('border-top-color', border);
          await expect(button).toHaveCSS('border-top-style', borderStyle);
          await expect(button).toHaveCSS('filter', 'none');
          await button.hover({ force: true });
          await expect(button).toHaveCSS('background-color', background);
          await expect(button).toHaveCSS('border-top-color', border);
          await expect(button).toHaveCSS('border-top-style', borderStyle);
          await expect(button).toHaveCSS('color', disabled.color);
          await expect(button).toHaveCSS('filter', 'none');
        }
      }
    }
  }
});
