import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

// 見本（design/）の、行で直に操作する部品（空の行、チップ、「⋯」、自動保存、取り消せるトースト、「/」の小窓）を
// バックログとスプリントの見本で通す。見本はアプリの配信対象外なので、共有の見本ファイルをそのまま返す。
const files: Record<string, string> = {
  'backlog.html': 'text/html',
  'sprint.html': 'text/html',
  'tokens.css': 'text/css',
  'components.css': 'text/css',
  'icons.js': 'text/javascript',
  'art.js': 'text/javascript',
  'sample-data.js': 'text/javascript',
  'kit.js': 'text/javascript',
};

async function openSample(page: Page, name: 'backlog.html' | 'sprint.html'): Promise<string[]> {
  await page.route('**/__design-catalog/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop()!;
    const contentType = files[file];
    if (!contentType) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ contentType, body: readFileSync(new URL(`../design/${file}`, import.meta.url)) });
  });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
    await page.route(`https://${host}/**`, (route) => route.fulfill({ body: '' }));
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/__design-catalog/${name}`);
  return errors;
}

test('見本のバックログ: 空の行に題を打って Enter で足し、続けて打てる。Esc では作らない', async ({ page }) => {
  const errors = await openSample(page, 'backlog.html');
  const draft = page.locator('input[data-draft="root:backlog"]');
  await draft.fill('見本で足す一件目');
  await draft.press('Enter');
  await expect(page.locator('.entry-title', { hasText: '見本で足す一件目' })).toHaveCount(1);
  // 同じ欄に戻り、続けて打てる
  await expect(draft).toBeFocused();
  await page.keyboard.type('二件目');
  await page.keyboard.press('Enter');
  await expect(page.locator('.entry-title', { hasText: '二件目' })).toHaveCount(1);
  // Esc は書きかけを消して離れ、作らない。空のまま Enter でも作らない
  const count = await page.locator('.entry-title').count();
  await page.keyboard.type('作らない題');
  await page.keyboard.press('Escape');
  await expect(draft).toHaveValue('');
  await draft.click();
  await draft.press('Enter');
  await expect(page.locator('.entry-title')).toHaveCount(count);
  expect(errors).toEqual([]);
});

test('見本のバックログ: 変換中の Enter では作らない', async ({ page }) => {
  await openSample(page, 'backlog.html');
  const draft = page.locator('input[data-draft="root:backlog"]');
  await draft.fill('へんかんちゅう');
  const count = await page.locator('.entry-title').count();
  // 変換中の Enter は keyCode 229 で届く
  await draft.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.entry-title')).toHaveCount(count);
  await expect(draft).toHaveValue('へんかんちゅう');
});

test('見本のバックログ: 「⋯」のメニューと、削除の取り消し、ストーリーの確認のダイアログ', async ({ page }) => {
  await openSample(page, 'backlog.html');
  const row = page.locator('.entry').first();
  const toggle = row.locator('.row-menu-btn');
  // 広い幅では行に触れるまで「⋯」は出ない
  await expect(toggle).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(toggle).toHaveCSS('opacity', '1');
  await toggle.click();
  const menu = row.locator('.row-menu-btn + .row-menu-list');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();

  // タスクはすぐ消え、取り消せる
  const titles = page.locator('.entry-title');
  const before = await titles.count();
  await toggle.click();
  await menu.locator('[data-task-delete]').click();
  await expect(titles).toHaveCount(before - 1);
  await expect(page.locator('#dialog')).toBeHidden();
  await page.locator('.toast-action').click();
  await expect(titles).toHaveCount(before);

  // 配下のあるストーリーは確認のダイアログ
  await page.locator('.tree-row.is-story .row-menu-btn').first().click();
  await page.locator('.tree-row.is-story [data-dialog="deleteStory"]').first().click();
  await expect(page.locator('#dialog .dialog-title')).toHaveText(/削除する/);
});

test('見本のバックログ: 幅 390px では「⋯」が常に出て 44px 四方', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page, 'backlog.html');
  const toggle = page.locator('.entry .row-menu-btn').first();
  await expect(toggle).toHaveCSS('opacity', '1');
  const box = await toggle.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test('見本の引き出し: 「編集」「保存」のボタンが無く、欄を離れると保存の状態が出る。「/」の小窓が開く', async ({
  page,
}) => {
  const errors = await openSample(page, 'backlog.html');
  await page.locator('a.entry-title').first().click();
  const drawer = page.locator('#drawer');
  await expect(drawer.locator('[data-drawer-input="title"]')).toBeVisible();
  // タイトル、リンク、本文、決まった欄の「編集」「保存」のボタンは無い（コメントの操作は別の流れ）
  await expect(drawer.locator('[data-drawer-edit], [data-drawer-save], [data-drawer-cancel]')).toHaveCount(0);

  const title = drawer.locator('[data-drawer-input="title"]');
  await title.fill('自動で保存するタイトル');
  await drawer.locator('[data-drawer-input="link"]').click();
  await expect(drawer.locator('[data-save-state="title"]')).toHaveText('保存しました');
  await expect(page.locator('.entry-title', { hasText: '自動で保存するタイトル' })).toHaveCount(1);

  // リンクは断られ、理由が欄の下に出て、入力は残る
  const link = drawer.locator('[data-drawer-input="link"]');
  await link.fill('ftp://example.com/spec');
  await title.click();
  await expect(drawer.locator('[data-drawer-error="link"]')).toBeVisible();
  await expect(link).toHaveValue('ftp://example.com/spec');
  // Esc は保存していない書きかけを保存した値に戻す
  await link.focus();
  await page.keyboard.press('Escape');
  await expect(link).not.toHaveValue('ftp://example.com/spec');
  await expect(drawer.locator('[data-drawer-error="link"]')).toBeHidden();

  // 「/」の小窓: 行の先頭で開き、上下で選んで Enter で入れる
  const body = drawer.locator('[data-drawer-input="body"]');
  await body.fill('');
  await body.focus();
  await page.keyboard.type('/');
  await expect(drawer.locator('.slash-menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(body).toHaveValue('## ');
  await page.keyboard.type('項目');
  await expect(drawer.locator('.slash-menu')).toBeHidden();

  // コメントはすぐ消え、確認のダイアログは出ない。取り消せる
  await drawer.locator('[data-comment-delete]').first().click();
  await expect(page.locator('#dialog')).toBeHidden();
  await expect(page.locator('.toast', { hasText: 'コメントを削除しました' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('見本のスプリント: 列の末尾の空の行に題を打って Enter で、その列にカードが足される', async ({ page }) => {
  await openSample(page, 'sprint.html');
  const draft = page.locator('input[data-draft^="col:"]').first();
  await draft.fill('列に足すカード');
  await draft.press('Enter');
  await expect(page.locator('.card-title', { hasText: '列に足すカード' })).toHaveCount(1);
  await expect(draft).toBeFocused();
});
