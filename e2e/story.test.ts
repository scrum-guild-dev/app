// 一本道: ストーリーを作る → 「＋タスク」でその下にタスクを作る → 完了にする → 「完了 / 全体」がその場で変わる（読み直しても同じ）。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { storyGet } from '../src/shared/operations/story/story-get.ts';
import { backlogTree } from '../src/shared/operations/task/backlog-tree.ts';
import { taskCreate } from '../src/shared/operations/task/task-create.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { createWorkspace, expectModalFocus, signIn, waitForSettled, watchViolations } from './helpers.ts';
import { failOperation, rewriteOperation, routeOperation } from './operations.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// seed のワークスペース。受託開発チーム（あおば開発）と社内ツール（ひばり工房）
const SEED_CLIENT_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const SEED_INTERNAL_WORKSPACE = '/hibari/w/019a0000-0000-7000-8000-000000000402';

// 木のストーリー1件。題はリンクで、押すとストーリーの引き出し（?story=<ID>）が開く
function storyGroup(page: Page, title: string) {
  return page.locator('.tree-group', { has: page.getByRole('link', { name: title, exact: true }) });
}

test('作ったワークスペース: ストーリーを作り、＋タスクでその下にタスクを作って完了にすると、「完了 / 全体」がその場で変わる', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '木のワークスペース');

  // ストーリーを作る。タイトル以外は空でよい
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const storyDialog = page.getByRole('dialog', { name: 'ストーリーを作る' });
  // 空のタイトルは送らずに知らせる
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog.getByText('タイトルを入れてください')).toBeVisible();
  await storyDialog.getByLabel('タイトル').fill('ポイント制度を公開する');
  await storyDialog.getByLabel('受け入れ基準').fill('- 残高が見える');
  await storyDialog.getByLabel('リンク').fill('ftp://example.com');
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog.getByText('http か https で始まる URL を入れてください')).toBeVisible();
  await storyDialog.getByLabel('リンク').fill('');
  await storyDialog.getByRole('button', { name: '作る' }).click();
  await expect(storyDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーを作りました' })).toBeVisible();

  const group = storyGroup(page, 'ポイント制度を公開する');
  await expect(group.locator('.tree-ratio')).toHaveText('完了 0 / 0 pt');
  await expect(group.getByText('タスクはまだありません')).toBeVisible();

  // 行の「＋タスク」から、親を選んだ状態でタスクのダイアログが開く。行は閉じない
  await group.getByRole('button', { name: 'タスクを足す: ポイント制度を公開する' }).click();
  const taskDialog = page.getByRole('dialog', { name: '起票' });
  await expect(taskDialog.getByLabel('親のストーリー').locator('option:checked')).toHaveText('ポイント制度を公開する');
  await expect(group.locator('.tree-children')).toBeVisible();
  await taskDialog.getByLabel('タイトル').fill('付与のバッチを書く');
  await taskDialog.getByRole('radio', { name: '3', exact: true }).check();
  await taskDialog.getByRole('button', { name: '起票' }).click();
  await expect(taskDialog).toBeHidden();
  // トーストには親の題を添える
  await expect(
    page.getByRole('status').filter({ hasText: 'ストーリー「ポイント制度を公開する」の末尾に足しました' }),
  ).toBeVisible();

  // 読み直さずに、親の配下に出る。「全体」のポイントには足される
  const row = group.locator('.entry', { hasText: '付与のバッチを書く' });
  await expect(row).toHaveCount(1);
  await expect(group.locator('.tree-ratio')).toHaveText('完了 0 / 3 pt');
  await expect(group.getByText('タスクはまだありません')).toHaveCount(0);

  // ストーリーの下でも完了にできる。行はその場に残り、完了の印が付き、その行のポイントが「完了」に足される
  await row.getByRole('button', { name: /完了にする/ }).click();
  await expect(row.getByRole('img', { name: '付与のバッチを書く: 完了' })).toBeVisible();
  await expect(group.locator('.tree-ratio')).toHaveText('完了 3 / 3 pt');
  // 折りたたみの件数は、読み直すまで変わらない
  await expect(group.locator('.tree-folded')).toHaveCount(0);

  // 読み直しても同じ。完了した行は件数の1行に畳まれる
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(group.locator('.tree-ratio')).toHaveText('完了 3 / 3 pt');
  await expect(group.locator('.tree-folded')).toHaveText('完了 1 件を折りたたんでいます');
  await expect(group.locator('.entry')).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

test('スクラムの言葉: 開閉は caret のボタンだけが受け持ち、題は引き出しを、「＋タスク」はダイアログを開いて、行を開閉しない', async ({
  page,
}) => {
  await createWorkspace(page, '木のチーム');
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const created = page.getByRole('dialog', { name: 'ストーリーを作る' });
  await created.getByLabel('タイトル').fill('請求の流れを整える');
  await created.getByRole('button', { name: '作る' }).click();
  await expect(created).toBeHidden();

  const group = storyGroup(page, '請求の流れを整える');
  const body = group.locator('.tree-children');
  const caret = group.locator('button.tree-caret');
  const addTask = group.getByRole('button', { name: 'タスクを足す: 請求の流れを整える' });
  const title = group.getByRole('link', { name: '請求の流れを整える', exact: true });
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(caret).toHaveAccessibleName('請求の流れを整えるを閉じる');
  await expect(caret).toHaveAttribute('aria-controls', (await body.getAttribute('id')) ?? '');

  // 開くと中にフォーカスが入り、Esc で閉じたら、開いたボタンへフォーカスが戻る（close の event は遅れて届くので、
  // 戻るのを待ってから次の操作をする）
  const storyDrawer = page.getByRole('dialog', { name: '請求の流れを整える', exact: true });
  const taskDialog = page.getByRole('dialog', { name: '起票' });

  // 題を押すと引き出しが開き、URL に ?story=<ID> が付く。行は開閉せず、Esc で閉じると URL から外れて題のリンクへフォーカスが戻る
  await expectModalFocus(page, {
    opener: title,
    modal: storyDrawer,
    whileOpen: async () => {
      await expect(page).toHaveURL(/\?story=[0-9a-f-]{36}$/);
      await expect(body).toBeVisible();
    },
  });
  await expect(page).not.toHaveURL(/\?story=/);

  // キーボード。「＋タスク」のボタンは Enter と Space で、題のリンクは Enter で開く。行は開閉しない
  for (const key of ['Enter', ' ']) {
    await expectModalFocus(page, {
      opener: addTask,
      modal: taskDialog,
      press: key,
      whileOpen: () => expect(caret).toHaveAttribute('aria-expanded', 'true'),
    });
  }
  await expectModalFocus(page, {
    opener: title,
    modal: storyDrawer,
    press: 'Enter',
    whileOpen: () => expect(caret).toHaveAttribute('aria-expanded', 'true'),
  });

  // caret のボタンで開閉する（クリックも Enter も Space も）。読み上げの名前は開閉で替わる
  await caret.click();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');
  await expect(caret).toHaveAccessibleName('請求の流れを整えるを開く');
  await expect(body).toBeHidden();
  for (const key of ['Enter', ' ']) {
    await caret.focus();
    await page.keyboard.press(key);
    await expect(body).toBeVisible();
    await page.keyboard.press(key);
    await expect(body).toBeHidden();
  }

  // 畳んだまま起票すると、親の行が開いて、足した行が見える
  await addTask.click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill('請求書の雛形を作る');
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog).toBeHidden();
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(group.locator('.entry', { hasText: '請求書の雛形を作る' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'ストーリー「請求の流れを整える」の末尾に足しました' }),
  ).toBeVisible();
});

test('ストーリーの引き出しは、開いたら1件を読み、押せば書けて、変えた欄だけを書き始めた時点の値を添えて送る。変えなければ何も送らない。過ぎた期日は赤い印で出る', async ({
  page,
}) => {
  await createWorkspace(page, '直すワークスペース');
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const created = page.getByRole('dialog', { name: 'ストーリーを作る' });
  await created.getByLabel('タイトル').fill('元のタイトル');
  await created.getByLabel('本文').fill('元の本文');
  await created.getByLabel('リンク').fill('https://example.com/spec');
  await created.getByRole('button', { name: '作る' }).click();
  await expect(created).toBeHidden();

  const updates: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/story-update')) updates.push(request.postDataJSON());
  });

  // 題のリンクで開く。リンクの横に、新しいタブで開く「開く」が出る
  await page.getByRole('link', { name: '元のタイトル', exact: true }).click();
  // 題を直すと引き出しの名前も替わるので、枠そのもので指す
  const drawer = page.locator('.drawer');
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('元のタイトル');
  await expect(drawer.getByText('元の本文')).toBeVisible();
  const open = drawer.getByRole('link', { name: 'リンクを新しいタブで開く' });
  await expect(open).toHaveText('開く');
  await expect(open).toHaveAttribute('href', 'https://example.com/spec');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', /noopener noreferrer/);

  // 「保存」のボタンは無い。押して書き始め、変えずに欄を離れると、送らずに読む形へ戻る
  await expect(drawer.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: /元のタイトル/ }).click();
  const titleInput = drawer.getByRole('textbox', { name: 'タイトル' });
  await expect(titleInput).toBeFocused();
  await titleInput.blur();
  await expect(titleInput).toBeHidden();
  expect(updates).toEqual([]);

  // タイトルは Enter で確定する。期日は選んだら少し待って保存する
  await drawer.getByRole('button', { name: /元のタイトル/ }).click();
  await titleInput.fill('新しいタイトル');
  await titleInput.press('Enter');
  await expect(drawer.getByRole('button', { name: /新しいタイトル/ })).toBeFocused();
  await drawer.getByLabel('期日').fill('2020-01-02');
  await expect.poll(() => updates.length).toBe(2);
  expect(Object.keys(updates[0] as object).sort()).toEqual(['expected', 'story_id', 'title', 'workspace_id']);
  expect(updates[0]).toMatchObject({ title: '新しいタイトル', expected: { title: '元のタイトル' } });
  expect(Object.keys(updates[1] as object).sort()).toEqual(['due_on', 'story_id', 'workspace_id']);
  expect(updates[1]).toMatchObject({ due_on: '2020-01-02' });

  // 読み直された木で、色だけでなく文字とアイコンを添えた赤い印が出る。ほかの欄は残っている
  const group = storyGroup(page, '新しいタイトル');
  const chip = group.locator('.chip.is-danger');
  await expect(chip).toHaveText('期日切れ 1/2');
  await expect(chip.locator('svg')).toHaveCount(1);
  await expect(drawer.getByText('元の本文')).toBeVisible();
  await expect(open).toHaveAttribute('href', 'https://example.com/spec');
});

test('ストーリーの引き出しは、読んでいる間は読み込み中を出し、読めなければもう一度試せ、消えていれば閉じて見出しにフォーカスを移す', async ({
  page,
}) => {
  await page.goto(SEED_CLIENT_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  const title = page.getByRole('link', { name: '問い合わせの一次回答を早くする', exact: true });
  const drawer = page.locator('.drawer');

  // 読んでいる間
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const unrouteGate = await routeOperation(page, storyGet, { slug: 'aoba' }, async (call) => {
    await gate;
    await call.passThrough();
  });
  await title.click();
  await expect(drawer.getByRole('status').filter({ hasText: '読み込んでいます' })).toHaveCount(1);
  await expect(drawer.getByRole('textbox')).toHaveCount(0);
  release();
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('問い合わせの一次回答を早くする');
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(drawer.getByText('よくある問い合わせ10件にテンプレートがある')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await unrouteGate();

  // 読めなかった（5xx）。もう一度試すで読み直す。失敗の文と「もう一度試す」へフォーカスを移す
  let failures = 1;
  const unrouteOnce = await routeOperation(page, storyGet, { slug: 'aoba' }, async (call) => {
    if (failures-- > 0) {
      await call.fail(503, 'unavailable');
    } else {
      await call.passThrough();
    }
  });
  await title.click();
  await expect(drawer.getByText('このストーリーを読み込めませんでした。')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'もう一度試す' })).toBeFocused();
  await drawer.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('問い合わせの一次回答を早くする');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await unrouteOnce();

  // 消えていた（404）。閉じて、知らせ、URL から外し、木を読み直し、見出しにフォーカスを移す
  await failOperation(page, storyGet, { slug: 'aoba' }, 404, 'not_found');
  await title.click();
  await expect(drawer).toHaveCount(0);
  await expect(page).not.toHaveURL(/\?story=/);
  await expect(page.getByRole('status').filter({ hasText: 'このストーリーは見つかりません' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeFocused();
  // 下の方の行を押すたびに Playwright がスクロールし、404 の後の木の読み直しで位置が上に戻るかが実行の速さで変わる。
  // 読み直しを待ってから、フォーカスした見出しのある一番上へ戻す（#491）
  await waitForSettled(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
});

test('日付の入力が途中までしか打たれていなければ、期日の欄に知らせて送らない', async ({ page }) => {
  await createWorkspace(page, '日付ワークスペース');
  await page.getByRole('button', { name: 'ストーリーを作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'ストーリーを作る' });
  await dialog.getByLabel('タイトル').fill('期日を入れる');
  let requests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/aoba/story-create')) requests++;
  });
  // 日付の入力は、年月日の一部だけだと value が空のまま、validity.badInput が立つ
  const due = dialog.getByLabel('期日');
  await due.focus();
  await page.keyboard.type('12');
  await expect(due).toHaveJSProperty('value', '');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog.getByText('期日は正しい日付で入れてください')).toBeVisible();
  await expect(due).toBeFocused();
  expect(requests).toBe(0);
});

test('期日の印: 過ぎた（赤）、今日と今週（橙）、それ以外（色なし）。今日と週の始まりは API の値', async ({ page }) => {
  // 今日と週の始まりは API が返す値で決まる。seed の日付（2026-10-20 前後）に合わせて差し替える
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    today: '2026-10-20',
    week_start: 1,
  }));
  await page.goto(SEED_CLIENT_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();

  const first = storyGroup(page, 'ポイントの付与と失効を管理画面で確かめられる');
  // ストーリーの期日（10/23）は今週
  await expect(first.locator('.tree-row .chip.is-warn')).toHaveText('今週 10/23');
  await expect(first.locator('.tree-ratio')).toHaveText('完了 5 / 10 pt');
  await expect(first.locator('.tree-folded')).toHaveText('完了 1 件を折りたたんでいます');
  const overdue = first.locator('.entry', { hasText: '失効日の計算に月末の扱いを足す' });
  await expect(overdue.locator('.chip.is-danger')).toHaveText('期日切れ 10/19');
  const thisWeek = first.locator('.entry', { hasText: '失効予定のポイントを知らせる文面を決める' });
  await expect(thisWeek.locator('.chip.is-warn')).toHaveText('今週 10/22');

  const second = storyGroup(page, '問い合わせの一次回答を早くする');
  await expect(
    second.locator('.entry', { hasText: '一次回答のテンプレートを10件書く' }).locator('.chip.is-warn'),
  ).toHaveText('今日まで');
  await expect(second.locator('.tree-row .chip')).toHaveCount(0);

  // 親のないタスクの期日（10/17）は過ぎている
  await expect(page.locator('.entry', { hasText: '障害時の連絡手順を書く' }).locator('.chip.is-danger')).toHaveText(
    '期日切れ 10/17',
  );

  // 今日を 10/12 に替えると、期日（10/19 以降）は来週以降で色なし
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    today: '2026-10-12',
    week_start: 1,
  }));
  await page.reload();
  await expect(first.locator('.tree-row .chip')).toHaveText('10/23');
  await expect(first.locator('.tree-row .chip.is-warn')).toHaveCount(0);
  await expect(page.locator('.chip.is-danger')).toHaveCount(0);
});

test('完了したストーリーには「＋タスク」を出さず、期日の印の色も付けない。タスクの親の候補にも出ない', async ({
  page,
}) => {
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    today: '2026-10-20',
    week_start: 1,
    stories: output.stories.map((story, index) =>
      index === 0 ? { ...story, completed_at: '2026-10-19T00:00:00.000Z' } : story,
    ),
  }));
  await page.goto(SEED_CLIENT_WORKSPACE);
  const done = storyGroup(page, 'ポイントの付与と失効を管理画面で確かめられる');
  await expect(done.locator('.tree-ratio')).toBeVisible();
  await expect(done.getByRole('button', { name: /タスクを足す/ })).toHaveCount(0);
  await expect(done.locator('.tree-row .chip')).toHaveText('10/23');
  await expect(done.locator('.tree-row .chip.is-warn')).toHaveCount(0);
  // もう一方のストーリーには出る
  await expect(
    storyGroup(page, '問い合わせの一次回答を早くする').getByRole('button', { name: /タスクを足す/ }),
  ).toBeVisible();

  await page.getByRole('button', { name: '起票' }).click();
  const parent = page.getByRole('dialog', { name: '起票' }).getByLabel('親のストーリー');
  // エピックの下の完了していないストーリーも、木の順（エピックの下が先）で候補に出る
  await expect(parent.locator('option')).toHaveText([
    'なし',
    '送料の割引にポイントを使える',
    '問い合わせの一次回答を早くする',
  ]);
});

test('親のストーリーが消えていたら、理由を出し、その場で候補を読み直して親なしに戻し、親の選択欄にフォーカスを移す', async ({
  page,
}) => {
  await page.goto(SEED_CLIENT_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  // 送ったときだけ 404 にして、読み直した木では候補から消えているようにする
  let gone = false;
  await routeOperation(page, taskCreate, { slug: 'aoba' }, async (call) => {
    gone = true;
    await call.fail(404, 'not_found');
  });
  await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => ({
    ...output,
    stories: output.stories.filter((story) => !(gone && story.title === '問い合わせの一次回答を早くする')),
  }));
  await page.reload();
  const addTask = storyGroup(page, '問い合わせの一次回答を早くする').getByRole('button', { name: /タスクを足す/ });
  await expect(addTask).toBeVisible();
  await waitForSettled(page);
  await addTask.click();
  const dialog = page.getByRole('dialog', { name: '起票' });
  await dialog.getByLabel('タイトル').fill('消えた親に足す');
  await dialog.getByRole('button', { name: '起票' }).click();
  await expect(dialog.getByText('このストーリーは見つかりません。親を選び直してください')).toBeVisible();
  const parent = dialog.getByLabel('親のストーリー');
  await expect(parent.locator('option')).toHaveText([
    'なし',
    '送料の割引にポイントを使える',
    'ポイントの付与と失効を管理画面で確かめられる',
  ]);
  await expect(parent).toHaveValue('');
  await expect(parent).toBeFocused();
  // ダイアログは開いたまま。親を選び直して作れる
  await expect(dialog).toBeVisible();
});

test('seed の社内ツール: ストーリーの行の合計と畳んだ件数が出る', async ({ page }) => {
  await page.goto(SEED_INTERNAL_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ストーリーを作る' })).toBeVisible();
  const group = storyGroup(page, '勤怠の締め処理を月末にまとめて回せる');
  await expect(group.locator('.tree-ratio')).toHaveText('完了 1 / 6 pt');
  await expect(group.locator('.tree-folded')).toHaveText('完了 1 件を折りたたんでいます');
  await expect(group.locator('.entry')).toHaveCount(2);
  await expect(storyGroup(page, '有給の残日数を自分で確かめられる').getByText('タスクはまだありません')).toBeVisible();
  // ストーリーの段が先で、親のないタスクは後
  const order = await page
    .locator('.tree > .tree-group, .tree > div:not(.draft-row)')
    .evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(order).toEqual(['tree-group', 'tree-group', '']);
});

test('閉じたワークスペースでは、作る操作と「＋タスク」を出さず、ストーリーの引き出しは読み取り専用で開く', async ({
  page,
}) => {
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-10-21T00:00:00.000Z',
  }));
  await page.goto(SEED_CLIENT_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ストーリーを作る' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /タスクを足す/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /タスクを足す/ })).toHaveCount(0);

  await page.getByRole('link', { name: 'ポイントの付与と失効を管理画面で確かめられる', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'ポイントの付与と失効を管理画面で確かめられる', exact: true });
  await expect(drawer.getByText(/読み取りだけできます/)).toBeVisible();
  // 入力欄も、直す口も、操作の「⋯」も、完了の帯も出さない。受け入れ基準、本文、期日は文字で出す
  await expect(drawer.getByRole('textbox')).toHaveCount(0);
  await expect(drawer.getByRole('heading', { level: 2 }).getByRole('button')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /^操作:/ })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '完了にする' })).toHaveCount(0);
  await expect(drawer.getByText('購入の確定でポイントが付く')).toBeVisible();
  await expect(drawer.getByText('先方の運用担当が、問い合わせを受けたときに')).toBeVisible();
  await expect(drawer.locator('.props').getByText('2026-10-23')).toBeVisible();
  // リンクは読み取り専用でも開ける
  await expect(drawer.getByRole('link', { name: 'リンクを新しいタブで開く' })).toHaveAttribute(
    'href',
    'https://example.com/notes/42',
  );
});

test('狭い幅では、caret、題、「＋タスク」の押せる範囲が 44px 四方以上に広がる（見た目は変わらない）', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(SEED_CLIENT_WORKSPACE);
  const group = storyGroup(page, '問い合わせの一次回答を早くする');
  await expect(group.locator('.tree-ratio')).toBeVisible();

  // 見た目の枠の外で、44px の範囲の中の点が、そのボタンに当たる
  async function reaches(button: Locator, dx: number, dy: number): Promise<boolean> {
    return button.evaluate(
      (element, offset) => {
        // elementFromPoint は画面の外の点に null を返すので、行を画面の中へ出してから測る
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2 + offset.dx,
          rect.top + rect.height / 2 + offset.dy,
        );
        return hit !== null && element.contains(hit);
      },
      { dx, dy },
    );
  }
  const caret = group.locator('button.tree-caret');
  const title = group.getByRole('link', { name: '問い合わせの一次回答を早くする', exact: true });
  const addTask = group.getByRole('button', { name: /タスクを足す/ });
  expect(await reaches(caret, 16, 0)).toBe(true);
  expect(await reaches(title, 0, -18)).toBe(true);
  expect(await reaches(addTask, 0, -18)).toBe(true);
  // 範囲を超えた点は当たらない
  expect(await reaches(title, 0, -60)).toBe(false);
});
