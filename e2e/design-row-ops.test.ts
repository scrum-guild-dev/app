import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { A11Y_THEMES, applyTheme } from './helpers.ts';

// 見本（design/）の、行で直に操作する部品（空の行、チップ、「⋯」、自動保存、取り消せるトースト、「/」の小窓）を
// バックログとスプリントの見本で通す。見本はアプリの配信対象外なので、共有の見本ファイルをそのまま返す。
const files: Record<string, string> = {
  'backlog.html': 'text/html',
  'index.html': 'text/html',
  'sprint.html': 'text/html',
  'tokens.css': 'text/css',
  'components.css': 'text/css',
  'icons.js': 'text/javascript',
  'art.js': 'text/javascript',
  'sample-data.js': 'text/javascript',
  'kit.js': 'text/javascript',
};

async function openSample(page: Page, name: 'backlog.html' | 'sprint.html' | 'index.html'): Promise<string[]> {
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
  // 同じ欄に戻り、欄は空になって、続けて打てる
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue('');
  await page.keyboard.type('二件目');
  await page.keyboard.press('Enter');
  await expect(page.locator('.entry-title').filter({ hasText: /^二件目$/ })).toHaveCount(1);
  await expect(page.locator('.entry-title', { hasText: '一件目二件目' })).toHaveCount(0);
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

  // ストーリーの行の「⋯」に削除は無く（並べ替えと親を移すだけ）、削除は題のリンクで開く引き出しの「⋯」から、確認のダイアログで行う
  const storyRow = page.locator('.tree-row.is-story').first();
  await storyRow.locator('.row-menu-btn').click();
  await expect(storyRow.locator('[data-dialog="deleteStory"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await storyRow.locator('a.tree-link').click();
  const drawer = page.locator('#drawer');
  await expect(drawer.locator('.drawer-top .chip').first()).toHaveText('ストーリー');
  await drawer.locator('.row-menu-btn').click();
  await drawer.locator('[data-dialog="deleteStory"]').click();
  await expect(page.locator('#dialog .dialog-title')).toHaveText(/削除する/);
  await expect(page.locator('#dialog .dialog-body')).toContainText(await storyRow.locator('a.tree-link').innerText());
  await page.locator('#dialog .btn.is-danger').click();
  await expect(drawer).toBeHidden();
});

test('見本のバックログ: ストーリーの題のリンクで引き出しが開き、完了の帯、自動保存、前後の移動、真ん中の形が動く', async ({
  page,
}) => {
  const errors = await openSample(page, 'backlog.html');
  const links = page.locator('.tree-row.is-story a.tree-link');
  const first = await links.first().textContent();
  await links.first().click();
  const drawer = page.locator('#drawer');
  await expect(drawer).toBeVisible();
  // 開き方は横と真ん中だけ。前後と、受け入れ基準、本文、期日、リンク、完了の帯が出る
  // 中身はアイコンだけで、名前は aria-label と title に持つ
  const modes = drawer.locator('[data-drawer-mode]');
  await expect(modes).toHaveCount(2);
  for (const [i, [name, icon]] of [
    ['横', 'panel'],
    ['真ん中', 'centered'],
  ].entries()) {
    await expect(modes.nth(i)).toHaveAttribute('aria-label', name);
    await expect(modes.nth(i)).toHaveAttribute('title', name);
    await expect(modes.nth(i).locator(`use[href="#i-${icon}"]`)).toHaveCount(1);
  }
  await expect(drawer.locator('[data-drawer-step]')).toHaveCount(2);
  await expect(drawer.locator('#drawer-edit-title')).toHaveValue(first!);
  await expect(drawer.locator('#drawer-edit-ac')).toBeVisible();
  await expect(drawer.locator('#drawer-edit-body')).toBeVisible();
  await expect(drawer.locator('[data-drawer-due]')).toBeVisible();
  await expect(drawer.locator('#drawer-edit-link')).toBeVisible();
  // 配下の未完了のタスクが残るあいだは、完了にできず、理由を添える
  const complete = drawer.locator('[data-story-done]');
  await expect(complete).toHaveAttribute('aria-disabled', 'true');
  await expect(drawer.locator('#drawer-story-remaining')).toContainText('残り');
  // 題の自動保存は、欄を離れると木の題にも反映する
  await drawer.locator('#drawer-edit-title').fill('題を直した');
  await drawer.locator('#drawer-edit-ac').focus();
  await expect(links.first()).toHaveText('題を直した');
  // 次のストーリーへ移ると、木で次のストーリーの題が入る
  const next = await links.nth(1).textContent();
  await drawer.locator('[data-drawer-step="1"]').click();
  await expect(drawer.locator('#drawer-edit-title')).toHaveValue(next!);
  // 真ん中の形へ替えると、枠が真ん中になり、開き方の押した印も移る
  await drawer.locator('[data-drawer-mode="center"]').click();
  await expect(drawer).toHaveClass(/is-center/);
  await expect(drawer.locator('[data-drawer-mode="center"]')).toHaveAttribute('aria-pressed', 'true');
  // 閉じる
  await drawer.locator('[data-close-drawer]').click();
  await expect(drawer).toBeHidden();
  expect(errors).toEqual([]);
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
  await expect(draft).toHaveValue('');
  await page.keyboard.type('次のカード');
  await page.keyboard.press('Enter');
  await expect(page.locator('.card-title').filter({ hasText: /^次のカード$/ })).toHaveCount(1);
});

test('見本のスプリント: 足しても、ほかの列の空の行の書きかけは残る', async ({ page }) => {
  await openSample(page, 'sprint.html');
  const drafts = page.locator('input[data-draft^="col:"]');
  await drafts.nth(1).fill('書きかけ');
  await drafts.first().fill('足すカード');
  await drafts.first().press('Enter');
  await expect(page.locator('.card-title').filter({ hasText: /^足すカード$/ })).toHaveCount(1);
  await expect(drafts.first()).toHaveValue('');
  await expect(drafts.nth(1)).toHaveValue('書きかけ');
});

test('見本のバックログ: 幅 390px で「⋯」を開くと、メニューが読める幅で画面の中に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page, 'backlog.html');
  await page.locator('.entry .row-menu-btn').first().click();
  const list = page.locator('.row-menu-list:not([hidden])');
  const box = (await list.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(150);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test('見本のスプリント: 先頭の列のカードのメニューが、盤面に切られず画面の中に収まる', async ({ page }) => {
  await openSample(page, 'sprint.html');
  await page.locator('.board-col').first().locator('.card .row-menu-btn').first().click();
  const box = (await page.locator('.row-menu-list:not([hidden])').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  const viewport = page.viewportSize()!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
});

test('見本のバックログ: 続けて消した2件を古い方から取り消しても、元の並びに戻る', async ({ page }) => {
  await openSample(page, 'backlog.html');
  const titles = page.locator('.tree > div:has(> .entry) > .entry .entry-title');
  const before = await titles.allTextContents();
  for (let i = 0; i < 2; i++) {
    await page.locator('.tree > div:has(> .entry) > .entry').first().hover();
    await page.locator('.tree > div:has(> .entry) > .entry .row-menu-btn').first().click();
    await page.locator('.row-menu-list:not([hidden]) [data-task-delete]').click();
  }
  await page.locator('.toast-action').first().click();
  await page.locator('.toast-action').first().click();
  expect(await titles.allTextContents()).toEqual(before);
});

test('見本のバックログ: 空の行の書きかけは別の行の操作で消えず、チップを選んだ後もフォーカスが戻る', async ({
  page,
}) => {
  await openSample(page, 'backlog.html');
  const story = page.locator('input[data-draft^="story:"]').first();
  await story.fill('書きかけのA');
  const root = page.locator('input[data-draft="root:backlog"]');
  await root.fill('Bを作る');
  await root.press('Enter');
  await expect(story).toHaveValue('書きかけのA');

  const chip = page.locator('.chip-btn.is-unset').first();
  const key = (await chip.getAttribute('data-chip-for'))!;
  await chip.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-chip-for="${key}"]`)).toBeFocused();
});

test('見本の引き出し: 「/」の小窓は開き直すと先頭が選ばれ、キャレットを離して Enter しても本文を壊さない', async ({
  page,
}) => {
  await openSample(page, 'backlog.html');
  await page.locator('a.entry-title').first().click();
  const body = page.locator('#drawer [data-drawer-input="body"]');
  await body.fill('');
  await body.focus();
  await page.keyboard.type('/');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await body.fill('');
  await page.keyboard.type('/');
  await page.keyboard.press('Enter');
  await expect(body).toHaveValue('# ');

  await body.fill('A\n\nB');
  await body.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 2));
  await page.keyboard.type('/');
  await expect(page.locator('#drawer .slash-menu')).toBeVisible();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await expect(body).toHaveValue('A\n/\nB\n');
});

test('見本の引き出し: タイトルとリンクを保存すると、見出しと「開く」が保存した値に替わる', async ({ page }) => {
  await openSample(page, 'backlog.html');
  await page.locator('a.entry-title').first().click();
  const drawer = page.locator('#drawer');
  await drawer.locator('[data-drawer-input="title"]').fill('見出しも替わる');
  await drawer.locator('[data-drawer-input="title"]').press('Enter');
  await expect(drawer.locator('#drawer-title')).toHaveText('見出しも替わる');
  const link = drawer.locator('[data-drawer-input="link"]');
  await link.fill('https://example.com/new');
  await link.press('Enter');
  await expect(drawer.locator('a[data-drawer-open]')).toHaveAttribute('href', 'https://example.com/new');
  await link.fill('');
  await link.press('Enter');
  await expect(drawer.locator('a[data-drawer-open]')).toHaveCount(0);
});

test('見本のバックログ: 幅390pxで横送りした各チップを44px四方で押せる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page, 'backlog.html');
  const chips = page.locator('.tree .entry.has-attrs .entry-chips').first().locator('.chip-btn');
  await expect(chips).toHaveCount(5);
  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    for (const chip of await chips.all()) {
      // 画面下に浮くタブバーと重ならない位置へ、縦と横をそれぞれ送る。
      await chip.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      const result = await chip.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const offsets = [
          [0, 0],
          [-21, 0],
          [21, 0],
          [0, -21],
          [0, 21],
        ];
        return {
          width: r.width,
          height: r.height,
          hits: offsets.every(([x, y]) => {
            const target = document.elementFromPoint(r.left + r.width / 2 + x, r.top + r.height / 2 + y);
            return target === el || el.contains(target);
          }),
        };
      });
      expect(result.width, theme).toBeGreaterThanOrEqual(44);
      expect(result.height, theme).toBeGreaterThanOrEqual(44);
      expect(result.hits, theme).toBe(true);
    }
  }
});

test('見本のバックログ: 下の行を先に、上の行を後に消し、古い方から取り消しても元の並びに戻る', async ({ page }) => {
  await openSample(page, 'backlog.html');
  const rows = '.tree > div:has(> .entry) > .entry';
  const titles = page.locator(`${rows} .entry-title`);
  const before = await titles.allTextContents();
  // 2 行目、1 行目の順に消す
  for (const index of [1, 0]) {
    await page.locator(rows).nth(index).hover();
    await page.locator(`${rows} .row-menu-btn`).nth(index).click();
    await page.locator('.row-menu-list:not([hidden]) [data-task-delete]').click();
  }
  await page.locator('.toast-action').first().click();
  await page.locator('.toast-action').first().click();
  expect(await titles.allTextContents()).toEqual(before);
});

test('見本のバックログ: ?story=<ID> で、ストーリーの引き出しが直接開く', async ({ page }) => {
  const errors = await openSample(page, 'backlog.html');
  await page.goto('/__design-catalog/backlog.html?story=s4');
  const drawer = page.locator('#drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('#drawer-edit-title')).toHaveValue('問い合わせの一次回答を早くする');
  await expect(drawer.locator('[data-story-done]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('見本のバックログ: ストーリーの引き出しの「親を移す」は、開いているストーリーの親を移す。不正な ?story= では開かない', async ({
  page,
}) => {
  const errors = await openSample(page, 'backlog.html');
  const links = page.locator('.tree-row.is-story a.tree-link');
  const second = await links.nth(1).innerText();
  await links.nth(1).click();
  const drawer = page.locator('#drawer');
  await drawer.locator('.row-menu-btn').click();
  await drawer.locator('[data-dialog="moveStory"]').click();
  await expect(page.locator('#dialog .dialog-title')).toContainText(second);
  await page.locator('#dialog [data-close-dialog]').first().click();

  // 存在しない ID と Object のプロパティ名では開かず、同時に付けた ?task= は開く
  await page.goto('/__design-catalog/backlog.html?story=constructor');
  await expect(page.locator('#drawer')).toBeHidden();
  await page.goto('/__design-catalog/backlog.html?story=nope&task=t1');
  await expect(page.locator('#drawer')).toBeVisible();
  expect(errors).toEqual([]);
});

test('見本のバックログ: 配下の未完了が残るストーリーは、完了にするを押しても完了にならない', async ({ page }) => {
  await openSample(page, 'backlog.html');
  await page.locator('.tree-row.is-story a.tree-link').first().click();
  const drawer = page.locator('#drawer');
  await drawer.locator('[data-story-done]').click({ force: true });
  await expect(drawer.locator('.hanko')).toHaveCount(0);
});

test('見本のチップ: ロックの理由、読み込み中、再試行と離脱済みの候補', async ({ page }) => {
  await openSample(page, 'backlog.html');
  const examples = page.locator('.attr-chip-examples');
  await examples.locator('summary').click();
  const locked = examples.locator('[data-chip-example="locked"] .chip-btn').first();
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  await expect(locked).toHaveAccessibleDescription('完了したタスクの属性は変更できません');
  await locked.focus();
  await locked.press('Enter');
  await expect(locked).not.toHaveAttribute('aria-expanded');

  const loading = examples.locator('[data-chip-example="loading"] .attr-chip').last();
  await loading.locator('.chip-btn').click();
  await expect(loading.getByRole('menu')).toHaveAttribute('aria-busy', 'true');
  await expect(loading.getByRole('menuitem')).toHaveText('読み込み中…');
  await page.keyboard.press('Escape');
  await expect(loading.locator('.chip-btn')).toBeFocused();

  const failed = examples.locator('[data-chip-example="failed"] .attr-chip').last();
  await failed.locator('.chip-btn').click();
  await failed.getByRole('menuitem', { name: /もう一度試す/ }).click();
  await expect(failed.getByRole('menuitemradio', { name: /離脱済み/ })).toHaveAttribute('aria-checked', 'true');
  await failed.getByRole('menuitemradio', { name: '担当なし', exact: true }).click();
  await expect(failed.locator('.chip-btn')).toBeFocused();
  await expect(failed.locator('.avatar')).toHaveCount(0);

  const left = examples.locator('[data-chip-example="left"] .attr-chip').last();
  await expect(left.locator(':scope > .avatar')).toHaveClass(/is-left/);
  await expect(left.locator('.chip-btn .avatar')).toHaveCount(0);
});

for (const theme of ['simple_light', 'simple_dark', 'medieval', 'modern']) {
  test(`見本のチップ: ${theme}、320px・文字150%で長い担当名が収まる`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await openSample(page, 'backlog.html');
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.style.fontSize = '150%';
    }, theme);
    await page.locator('.attr-chip-examples summary').click();
    const row = page.locator('[data-chip-example="long"]');
    const chip = row.locator('.attr-chip').last().locator('.chip-btn');
    const box = (await chip.boundingBox())!;
    const bounds = (await row.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    await expect(chip.locator('.ico')).toHaveCount(1);
  });
}

test('カタログの横送りの見本で属性と行の操作を選んでも、同じ見本へフォーカスが戻る', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openSample(page, 'index.html');
  const points = page.locator('#tree [data-chip-for="t15:pts"]');
  await expect(page.locator('[data-chip-for="t15:pts"]')).toHaveCount(1);
  await points.click();
  await page.getByRole('menuitemradio', { name: '5 pt', exact: true }).click();
  await expect(points).toHaveText('5 pt');
  await expect(points).toBeFocused();
  const menu = page.locator('#tree [data-menu-for="t15"]');
  await expect(page.locator('[data-menu-for="t15"]')).toHaveCount(1);
  await menu.click();
  await page.getByRole('menuitem', { name: '今日やる', exact: true }).click();
  await expect(menu).toBeFocused();
  expect(errors).toEqual([]);
});
