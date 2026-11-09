// タスクの詳細の開き方（引き出し、真ん中、ページ全体、新しいタブ）と、端末の既定の切り替え。
// 引き出しの中の編集は e2e/task-drawer.test.ts（CI のシャードに散るよう分けた）。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { addTaskRow, createWorkspace, settledScrollY, signIn, waitForSettled } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 引き出し（かページ全体）の帯にある、開き方のボタン。押した時点で実行する
function modeButton(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('group', { name: '開き方' }).getByRole('button', { name, exact: true });
}

// 端末の既定（localStorage）。読み直しても残るので、画面を替えずに読める
function storedMode(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('task-open-mode'));
}

test('ページ全体は一覧を重ねず、アプリ内から来た画面へ閉じ、直接開いたらバックログへ閉じる', async ({ page }) => {
  await createWorkspace(page, '詳細ページワークスペース');
  await addTaskRow(page, 'ページだけで読む');
  const backlog = page.url();
  await page.getByRole('link', { name: 'ページだけで読む', exact: true }).click();
  await expect(page).toHaveURL(/[?&]task=[0-9a-f-]{36}/);
  const id = new URL(page.url()).searchParams.get('task')!;
  await page
    .getByRole('dialog', { name: 'ページだけで読む' })
    .getByRole('button', { name: '閉じる', exact: true })
    .click();
  const members = `${backlog}/members`;
  await page.goto(`${members}?task=${id}`);
  // 開き方はアイコンだけのボタンで、名前は載せたときの title にも出す
  const opened = page.getByRole('dialog', { name: 'ページだけで読む' });
  for (const name of ['横', '真ん中', 'ページ全体', '新しいタブ']) {
    await expect(modeButton(opened, name)).toHaveAttribute('title', name);
    await expect(modeButton(opened, name).locator('svg.ico')).toBeVisible();
  }
  // 押している形は色に加えて、線を太くし、枠を内側に足して二重にする
  await expect(modeButton(opened, '横').locator('svg.ico')).toHaveCSS('stroke-width', '2.6px');
  await expect(modeButton(opened, '真ん中').locator('svg.ico')).toHaveCSS('stroke-width', '1.8px');
  await expect(modeButton(opened, '横')).not.toHaveCSS('box-shadow', 'none');
  await expect(modeButton(opened, '真ん中')).toHaveCSS('box-shadow', 'none');
  await modeButton(opened, 'ページ全体').click();
  const detail = `${backlog}/tasks/${id}`;
  await expect(page).toHaveURL(detail);
  const region = page.getByRole('region', { name: 'ページだけで読む', exact: true });
  await expect(region).toBeVisible();
  // 引き出しからページ全体へ移った直後も、ページ全体の見出しにフォーカスがある（レイアウトが行へ戻すフォーカスで奪わない）
  await expect(region.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.locator('.entry')).toHaveCount(0);
  await expect(page.locator('.scrim')).toHaveCount(0);
  await expect(page.locator('.binding')).not.toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(members);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  // 直接開くと afterNavigate の from.url が null になる。その経路で例外が出ない
  const uncaught: string[] = [];
  page.on('pageerror', (error) => uncaught.push(error.message));
  await page.goto(detail);
  await page.reload();
  await expect(region).toBeVisible();
  expect(uncaught).toEqual([]);
  await region.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page).toHaveURL(backlog);
  await expect(page.getByRole('link', { name: 'ページだけで読む', exact: true })).toBeFocused();
  // ページの既定から行を押すとページへ移り、横に替えると戻り先に重なる。
  await page.getByRole('link', { name: 'ページだけで読む', exact: true }).click();
  await expect(page).toHaveURL(detail);
  await modeButton(region, '横').click();
  await expect(page).toHaveURL(`${backlog}?task=${id}`);
  await expect(page.getByRole('dialog', { name: 'ページだけで読む' })).toBeVisible();
});

test('開き方の変更は書きかけを確認し、新しいタブなら詳細を閉じる。既定の別タブは元画面を保つ', async ({ page }) => {
  await createWorkspace(page, '別タブワークスペース');
  await addTaskRow(page, '別タブで読む');
  const backlog = page.url();
  const row = page.getByRole('link', { name: '別タブで読む', exact: true });
  await row.click();
  await expect(page).toHaveURL(/[?&]task=[0-9a-f-]{36}/);
  const id = new URL(page.url()).searchParams.get('task')!;
  const drawer = page.getByRole('dialog', { name: '別タブで読む' });
  await drawer.getByRole('textbox', { name: 'コメントを書く', exact: true }).fill('残したい書きかけ');
  await modeButton(drawer, '真ん中').click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(modeButton(drawer, '真ん中')).toBeFocused();
  await expect(drawer.getByRole('textbox', { name: 'コメントを書く', exact: true })).toHaveValue('残したい書きかけ');
  await expect(modeButton(drawer, '横')).toHaveAttribute('aria-pressed', 'true');
  await modeButton(drawer, '新しいタブ').click();
  await expect(confirm).toBeVisible();
  const opened = page.waitForEvent('popup');
  await confirm.getByRole('button', { name: '捨てる', exact: true }).click();
  const other = await opened;
  await expect(other).toHaveURL(`${backlog}/tasks/${id}`);
  await expect(other.getByRole('region', { name: '別タブで読む', exact: true })).toBeVisible();
  await expect(page).toHaveURL(backlog);
  await expect(drawer).toBeHidden();
  await expect(row).toBeFocused();
  await other.keyboard.press('Escape');
  await expect(other).toHaveURL(backlog);
  await other.close();
  const nextPopup = page.waitForEvent('popup');
  await row.click();
  const next = await nextPopup;
  await expect(next).toHaveURL(`${backlog}/tasks/${id}`);
  await expect(page).toHaveURL(backlog);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await next.close();
});

test('開き方のボタンは押したときだけ実行する。矢印キーでは何も起きず、押した形は描いている形と同じでも既定になる', async ({
  page,
}) => {
  await createWorkspace(page, '既定ワークスペース');
  await addTaskRow(page, '既定を替える');
  const backlog = page.url();
  await page.getByRole('link', { name: '既定を替える', exact: true }).click();
  await expect(page).toHaveURL(/[?&]task=[0-9a-f-]{36}/);
  const id = new URL(page.url()).searchParams.get('task')!;
  const drawer = page.getByRole('dialog', { name: '既定を替える' });
  await expect(drawer).toBeVisible();
  await modeButton(drawer, '横').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(`${backlog}?task=${id}`);
  await expect(drawer).toBeVisible();
  expect(await storedMode(page)).toBeNull();
  await modeButton(drawer, 'ページ全体').click();
  await expect(page).toHaveURL(`${backlog}/tasks/${id}`);
  expect(await storedMode(page)).toBe('page');
  // 既定がページ全体のまま `?task=` を直接開くと、横で描く。ここで「横」を押すと、移らずに既定が横になる
  await page.goto(`${backlog}?task=${id}`);
  await expect(drawer).toBeVisible();
  await expect(modeButton(drawer, '横')).toHaveAttribute('aria-pressed', 'true');
  await modeButton(drawer, '横').click();
  await expect(page).toHaveURL(`${backlog}?task=${id}`);
  await expect(drawer).toBeVisible();
  await expect.poll(() => storedMode(page)).toBe('side');
});

test('既定のページ全体へ行のリンクで来て閉じると、履歴を戻って絞り込みの付いた一覧と行のフォーカスが戻り、履歴が重ならない', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('task-open-mode', 'page'));
  await createWorkspace(page, '絞り込みワークスペース');
  await addTaskRow(page, '絞り込みから読む');
  const backlog = page.url();
  await page.goto(`${backlog}?q=${encodeURIComponent('絞り込み')}`);
  const filtered = page.url();
  const link = page.getByRole('link', { name: '絞り込みから読む', exact: true });
  await link.click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const detail = page.url();
  const region = page.getByRole('region', { name: '絞り込みから読む', exact: true });
  await region.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page).toHaveURL(filtered);
  await expect(link).toBeFocused();
  // リンクで来たときは履歴を戻って閉じる。置き換えて同じ一覧を重ねていれば、進む先が無い（戻る／進むで来たときは置き換えて移る）
  await page.goForward();
  await expect(page).toHaveURL(detail);
});

test('存在しないタスクの URL を直接開くと、トーストで知らせてバックログへ移る', async ({ page }) => {
  await createWorkspace(page, '消えた詳細ワークスペース');
  const backlog = page.url();
  await page.goto(`${backlog}/tasks/019a0000-0000-7000-8000-00000000ffff`);
  await expect(page.getByRole('status').filter({ hasText: 'このタスクは見つかりません' })).toBeVisible();
  await expect(page).toHaveURL(backlog);
});

test('ページ全体から新しいタブを選ぶと、別タブで開き、元のタブは直前の画面へ戻る', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('task-open-mode', 'page'));
  await createWorkspace(page, '別タブ移りワークスペース');
  await addTaskRow(page, 'ページから別タブへ');
  const backlog = page.url();
  const link = page.getByRole('link', { name: 'ページから別タブへ', exact: true });
  await link.click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const detail = page.url();
  const region = page.getByRole('region', { name: 'ページから別タブへ', exact: true });
  const opened = page.waitForEvent('popup');
  await modeButton(region, '新しいタブ').click();
  const other = await opened;
  await expect(other).toHaveURL(detail);
  await expect(page).toHaveURL(backlog);
  await expect(link).toBeFocused();
  expect(await storedMode(page)).toBe('tab');
  await other.close();
});

test('新しいタブを開けなかったら、詳細も既定もそのままにして、トーストで知らせる', async ({ page }) => {
  await createWorkspace(page, '遮断ワークスペース');
  await addTaskRow(page, '遮断されて読む');
  const backlog = page.url();
  await page.getByRole('link', { name: '遮断されて読む', exact: true }).click();
  await expect(page).toHaveURL(/[?&]task=[0-9a-f-]{36}/);
  const id = new URL(page.url()).searchParams.get('task')!;
  const drawer = page.getByRole('dialog', { name: '遮断されて読む' });
  await expect(drawer).toBeVisible();
  await page.evaluate(() => {
    window.open = () => null;
  });
  await modeButton(drawer, '新しいタブ').click();
  await expect(page.getByRole('status').filter({ hasText: '新しいタブを開けませんでした' })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(`${backlog}?task=${id}`);
  expect(await storedMode(page)).toBeNull();
  // 閉じる操作は生きている
  await drawer.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(drawer).toBeHidden();
});

test('ページ全体は、左のメニューにフォーカスがあるときの Esc では閉じない', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('task-open-mode', 'page'));
  await createWorkspace(page, 'メニュー Esc ワークスペース');
  await addTaskRow(page, 'Esc を確かめる');
  await page.getByRole('link', { name: 'Esc を確かめる', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const detail = page.url();
  const region = page.getByRole('region', { name: 'Esc を確かめる', exact: true });
  await expect(region).toBeVisible();
  await page.getByRole('navigation').first().getByRole('link').first().focus();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(detail);
  await expect(region).toBeVisible();
  await region.getByRole('button', { name: '閉じる', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(detail);
});

test('別のタブで替えた既定は、開きっぱなしのタブにも反映される', async ({ context, page }) => {
  await createWorkspace(page, '同期ワークスペース');
  await addTaskRow(page, '同期して読む');
  const backlog = page.url();
  const link = page.getByRole('link', { name: '同期して読む', exact: true });
  await expect(link).toHaveAttribute('href', /\?task=/);
  const other = await context.newPage();
  await other.goto(backlog);
  await other.evaluate(() => localStorage.setItem('task-open-mode', 'page'));
  await expect(link).toHaveAttribute('href', /\/tasks\/[0-9a-f-]{36}$/);
  await other.close();
});

test('既定がページ全体のとき、一覧のスクロールの位置を詳細のページへ持ち越さない', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('task-open-mode', 'page'));
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
  // 木の下のほうにある seed の親なしのタスク。.last() にすると、並べて走る e2e/tree-add-row.test.ts が足して消す行を拾う
  const link = page.getByRole('link', { name: '問い合わせテンプレートを整える', exact: true });
  await expect(link).toBeVisible();
  await waitForSettled(page);
  await settledScrollY(page);
  await link.scrollIntoViewIfNeeded();
  expect(await settledScrollY(page), '前提: バックログが縦にスクロールする').toBeGreaterThan(0);
  await link.click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(page.locator('.drawer.is-page')).toBeVisible();
  expect(await settledScrollY(page)).toBe(0);
});
