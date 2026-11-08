// 引き出し（タスク、ストーリー、エピック）を開いている間に、背後のバックログの行の「⋯」へ届くか（#977、#978）。
// 横と真ん中の引き出しは aria-modal のダイアログで、外側に inert を付ける（Drawer.svelte の inertOutside）。
// ポインターは幕が受け止め、キーボードは Tab と Shift+Tab で一巡しても inert の中へ着かないので、引き出しを開いたまま
// 同じタスク（ストーリーとエピックの配下のタスク）を行の「⋯」から消す操作は起きない。
// そのため、削除の後に引き出しを閉じる処理（task-removal.ts の closeDrawer）は念のためのもので、書きかけの確認を黙らせる口は足さない。
// ストーリーとエピックの引き出しの子の一覧も、行の「⋯」の削除では読み直さない（docs/design.md の「行の「⋯」」）。
// あおば開発の管理者ミナトで、ワークスペースを作って行を足して使う（seed の行を消さない）
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { backlogTree } from '../src/shared/operations/task/index.ts';
import { addEpicRow, addStoryRow, addTaskRow, createWorkspace, rowMenuToggle, signIn } from './helpers.ts';
import { failOperation } from './operations.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 1 巡に足りる回数。引き出しの中の止まる先（帯のボタン、欄、コメント）より多く押す
const PRESSES = 60;

// 背後の行の「⋯」へ、ポインターでもキーボードでも着けないことを確かめる
async function expectRowMenuUnreachable(page: Page, drawer: Locator, title: string): Promise<void> {
  const toggle = rowMenuToggle(page, title);
  // 外側は inert
  expect(await toggle.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);
  // ポインターは幕が受け止める
  await expect(toggle.click({ trial: true, timeout: 2000 })).rejects.toThrow('intercepts pointer events');
  // プログラムから focus() を呼んでも着かない（inert の中の要素はフォーカスを受けない）
  await toggle.evaluate((element) => (element as HTMLElement).focus());
  await expect(toggle).not.toBeFocused();
  // Tab と Shift+Tab で一巡しても、inert の中（背後の行とその「⋯」）には着かない
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < PRESSES; i++) {
      await page.keyboard.press(key);
      const inInert = await page.evaluate(() => document.activeElement?.closest('[inert]') != null);
      expect(inInert, `${key} を ${i + 1} 回押したら、背後の inert の中にフォーカスが着いた`).toBe(false);
    }
  }
  await expect(toggle).not.toBeFocused();
  await expect(drawer).toBeVisible();
}

test('書きかけのあるタスクの引き出しを開いたまま、背後の同じ行の「⋯」へはポインターでもキーボードでも着けない（#977）', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await createWorkspace(page, '引き出しの背後のタスク');
  await addTaskRow(page, '書きかけの行');
  await page.getByRole('link', { name: '書きかけの行', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '書きかけの行' });
  await expect(drawer).toBeVisible();
  const comment = drawer.getByRole('textbox', { name: 'コメントを書く', exact: true });
  await comment.fill('消す前の書きかけ');

  await expectRowMenuUnreachable(page, drawer, '書きかけの行');
  // 書きかけは残り、破棄の確認も出ていない
  await expect(comment).toHaveValue('消す前の書きかけ');
  await expect(page.getByRole('dialog', { name: '書きかけを捨てますか' })).toHaveCount(0);
});

test('ストーリーの引き出しを開いたまま、背後の子タスクの行の「⋯」へは着けない（#978）', async ({ page }) => {
  test.setTimeout(60_000);
  await createWorkspace(page, '引き出しの背後のストーリー');
  await addStoryRow(page, '背後のストーリー');
  await addTaskRow(page, 'ストーリーの子タスク', '背後のストーリー');
  await page.getByRole('link', { name: '背後のストーリー', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '背後のストーリー' });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/[?&]story=[0-9a-f-]{36}/);

  await expectRowMenuUnreachable(page, drawer, 'ストーリーの子タスク');
});

test('エピックの引き出しを開いたまま、背後の配下のタスクの行の「⋯」へは着けない（#978）', async ({ page }) => {
  test.setTimeout(60_000);
  await createWorkspace(page, '引き出しの背後のエピック');
  await addEpicRow(page, '背後のエピック');
  await addStoryRow(page, 'エピックのストーリー', '背後のエピック');
  await addTaskRow(page, 'エピックの孫タスク', 'エピックのストーリー');
  await page.getByRole('link', { name: '背後のエピック', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '背後のエピック' });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/[?&]epic_id=[0-9a-f-]{36}/);

  await expectRowMenuUnreachable(page, drawer, 'エピックの孫タスク');
});

// 引き出しを開いている間に、背後の一覧が作り直される（木の読み込みの失敗で読み込みの失敗の画面に替わり、戻ると木を作り直す）。
// 後から差し込まれた要素にも inert が付き、背後の「もう一度試す」と作り直した行の「⋯」へキーボードで着けない（反証 QA の筋書き）
test('引き出しを開いたまま背後の一覧が作り直されても、新しい要素に inert が付き、行の「⋯」へ着けない（#977）', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await createWorkspace(page, '引き出しの背後の作り直し');
  await addTaskRow(page, '作り直される行');
  await page.getByRole('link', { name: '作り直される行', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '作り直される行' });
  await expect(drawer).toBeVisible();

  // 欄を保存すると木を読み直す。木だけを失敗させ、背後を読み込みの失敗の画面に替える
  const unroute = await failOperation(page, backlogTree, { slug: 'aoba' }, 500, 'internal');
  await drawer.getByLabel('期日').fill('2099-12-31');
  const retry = page.getByRole('button', { name: 'もう一度試す', exact: true });
  await expect(retry).toHaveCount(1);
  expect(await retry.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);

  // 木を戻して、もう一度保存して読み直す。作り直した行の「⋯」にも届かない
  await unroute();
  await drawer.getByLabel('期日').fill('');
  await expect(rowMenuToggle(page, '作り直される行')).toHaveCount(1);
  await expectRowMenuUnreachable(page, drawer, '作り直される行');

  // 閉じると、後から付けた inert も外れ、作り直した行の「⋯」を押せる
  await drawer.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(drawer).toBeHidden();
  const toggle = rowMenuToggle(page, '作り直される行');
  await expect.poll(() => toggle.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);
  await toggle.click();
  await expect(page.getByRole('menu', { name: '操作: 作り直される行', exact: true })).toBeVisible();
});
