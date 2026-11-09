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
  await page.goto('/consent');
  const button = page.getByRole('button', { name: '同意して進む' });
  const checkbox = page.getByRole('checkbox');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of A11Y_THEMES) {
      await applyTheme(page, theme);
      const disabled = await buttonColors(button);
      expect(disabled.ratio, `${theme} ${width}px`).toBeGreaterThanOrEqual(4.5);
      expect(disabled.opacity).toBe('1');
      await button.hover();
      await expect(button).toHaveCSS('background-color', disabled.background);
      await expect(button).toHaveCSS('color', disabled.color);
      await button.click({ force: true });
      await expect(checkbox).not.toBeChecked();
      await expect(page).toHaveURL(/\/consent$/);
      await checkbox.check();
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await expect(button).not.toHaveCSS('background-color', disabled.background);
      await checkbox.uncheck();
      await expect(button).toHaveAttribute('aria-disabled', 'true');
    }
  }
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
    const background = luminance(style.backgroundColor);
    return {
      ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      opacity: style.opacity,
      background: style.backgroundColor,
      color: style.color,
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
        last_used_at: '2026-10-20T00:12:00.000Z',
        self_created: false,
        trial_ends_on: null,
        trial_expired: false,
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
      for (const name of ['停止しています', 'やめる']) {
        const button = dialog.getByRole('button', { name });
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        const disabled = await buttonColors(button);
        expect(disabled.ratio, `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(disabled.opacity).toBe('1');
        await button.hover();
        await expect(button).toHaveCSS('color', disabled.color);
        await expect(button).toHaveCSS('background-color', disabled.background);
      }
    }
  } finally {
    release();
  }
});
