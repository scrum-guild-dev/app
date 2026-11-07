// 引き出しとページ全体の前後のボタンとキー（[ と ]）で、開いたまま隣のタスクへ移る。
// 引き出しの中の編集は e2e/task-drawer.test.ts（CI のシャードに散るよう分けた）。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { addStoryRow, addTaskRow, createWorkspace, expectFocusReturned, signIn, waitForResponses } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 引き出し（かページ全体）の帯にある、開き方のボタン。押した時点で実行する
function modeButton(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('group', { name: '開き方' }).getByRole('button', { name, exact: true });
}

// 引き出しを開いた行を、タイトルで探して開く
async function openDrawer(page: Page, title: string) {
  await page.locator('.entry', { hasText: title }).getByRole('link', { name: title }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  return drawer;
}

// 行のリンクの `?task=<ID>` から、タスクの ID を取る
async function taskIdOf(page: Page, title: string): Promise<string> {
  const href = await page.locator('.entry', { hasText: title }).getByRole('link', { name: title }).getAttribute('href');
  return new URL(href!, 'http://localhost').searchParams.get('task')!;
}

// 帯の前後のボタン（開き方の左）。名前はワークスペースの言葉（「タスク」）
function stepGroup(scope: Page | Locator): Locator {
  return scope.getByRole('group', { name: '前後のタスク' });
}

function stepButton(scope: Page | Locator, direction: '前' | '次'): Locator {
  return stepGroup(scope).getByRole('button', { name: `${direction}のタスク`, exact: true });
}

// 木の空の行で作る（作った行は読み直さずに木へ入る）
async function createStory(page: Page, title: string): Promise<void> {
  await addStoryRow(page, title);
}

test('前後のボタンとキーで、開いたまま隣のタスクへ移る。端で止まり、履歴は積まず、Esc で最後に表示した行へ戻る', async ({
  page,
}) => {
  await createWorkspace(page, '前後ワークスペース');
  await addTaskRow(page, '前後 一');
  await addTaskRow(page, '前後 二');
  await addTaskRow(page, '前後 三');
  const drawer = await openDrawer(page, '前後 二');
  const historyLength = await page.evaluate(() => history.length);

  // 途中では、前も次も押せる
  await expect(stepButton(drawer, '前')).toHaveAttribute('aria-disabled', 'false');
  await expect(stepButton(drawer, '次')).toHaveAttribute('aria-disabled', 'false');

  // 次へ。開いたまま詳細が替わり、URL の ?task= だけが変わる（履歴は積まない）
  await stepButton(drawer, '次').click();
  const third = page.getByRole('dialog', { name: '前後 三' });
  await expect(third).toBeVisible();
  await expect(page).toHaveURL(/\?task=[0-9a-f-]{36}$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // 末尾では次が押せず、押しても動かない。キー `]` も動かない
  await expect(stepButton(third, '次')).toHaveAttribute('aria-disabled', 'true');
  await expect(stepButton(third, '前')).toHaveAttribute('aria-disabled', 'false');
  await stepButton(third, '次').click({ force: true });
  await page.keyboard.press(']');
  await expect(third).toBeVisible();

  // キー `[` で前へ戻る。先頭まで戻ると、前が押せなくなる
  await page.keyboard.press('[');
  await expect(page.getByRole('dialog', { name: '前後 二' })).toBeVisible();
  await page.keyboard.press('[');
  const first = page.getByRole('dialog', { name: '前後 一' });
  await expect(first).toBeVisible();
  await expect(stepButton(first, '前')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('[');
  await expect(first).toBeVisible();

  // 開いた行（二）ではなく、そのとき開いている行（一）へ、Esc でフォーカスが戻る。移った先の表示を待ってから戻る
  await stepButton(first, '次').click();
  await expect(page.getByRole('dialog', { name: '前後 二' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(first).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(first).toBeHidden();
  await expectFocusReturned(page, page.locator('.entry').getByRole('link', { name: '前後 一', exact: true }));
});

test('ボタンで移ると、押した向きのボタンにフォーカスが残り、移った先のタイトルが読み上げられる', async ({ page }) => {
  await createWorkspace(page, '読み上げワークスペース');
  await addTaskRow(page, '読み上げ 一');
  await addTaskRow(page, '読み上げ 二');
  await addTaskRow(page, '読み上げ 三');
  const drawer = await openDrawer(page, '読み上げ 一');

  // 次へ。置き直した引き出しは、閉じるボタンではなく押した向きのボタンにフォーカスを置く（Enter を押し続けても閉じない）
  await stepButton(drawer, '次').focus();
  await page.keyboard.press('Enter');
  const second = page.getByRole('dialog', { name: '読み上げ 二' });
  await expect(second).toBeVisible();
  await expect(stepButton(second, '次')).toBeFocused();
  await expect(second.getByRole('button', { name: '閉じる' })).not.toBeFocused();
  await expect(second.getByRole('status').filter({ hasText: '「読み上げ 二」に移りました' })).toHaveCount(1);

  // 押し続けた2回目の Enter は、続けて次へ移る（閉じない）
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '読み上げ 三' })).toBeVisible();
});

test('順は開いた画面の見えている行。絞り込みで外れた行と、畳んだ枝の中の行は飛ばす', async ({ page }) => {
  await createWorkspace(page, '飛ばすワークスペース');
  await createStory(page, '畳む親');
  for (const title of ['枝の一', '枝の二']) await addTaskRow(page, title, '畳む親');
  await addTaskRow(page, '検索 甲');
  await addTaskRow(page, '別件 乙');
  await addTaskRow(page, '検索 丙');
  const workspacePath = new URL(page.url()).pathname;

  // 木の順は、ストーリーの配下（枝の一、枝の二）、親なしの甲、乙、丙。ストーリーの行は数えない
  const drawer = await openDrawer(page, '枝の一');
  await expect(stepButton(drawer, '前')).toHaveAttribute('aria-disabled', 'true');
  await stepButton(drawer, '次').click();
  await expect(page.getByRole('dialog', { name: '枝の二' })).toBeVisible();
  await stepButton(page.getByRole('dialog', { name: '枝の二' }), '次').click();
  await expect(page.getByRole('dialog', { name: '検索 甲' })).toBeVisible();
  await page.keyboard.press('Escape');

  // 親を畳むと、配下は飛ばす（甲の前は無く、先頭になる）
  await page.getByRole('button', { name: '畳む親を閉じる' }).click();
  const afterFold = await openDrawer(page, '検索 甲');
  await expect(stepButton(afterFold, '前')).toHaveAttribute('aria-disabled', 'true');
  await expect(stepButton(afterFold, '次')).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '畳む親を開く' }).click();

  // 絞り込みで外れた行（乙）は飛ばす。ほかのクエリは残る
  await page.goto(`${workspacePath}?q=検索`);
  const filtered = await openDrawer(page, '検索 甲');
  await stepButton(filtered, '次').click();
  await expect(page.getByRole('dialog', { name: '検索 丙' })).toBeVisible();
  await expect(page).toHaveURL(/\?q=%E6%A4%9C%E7%B4%A2&task=[0-9a-f-]{36}$/);
  await expect(stepButton(page.getByRole('dialog', { name: '検索 丙' }), '次')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('書きかけがあるまま前後へ移ろうとすると確かめる。書き続けると移らず、捨てると移る。入力欄の中の [ ] と変換中は移らない', async ({
  page,
}) => {
  await createWorkspace(page, '前後の確認ワークスペース');
  await addTaskRow(page, '確認 一');
  await addTaskRow(page, '確認 二');
  const drawer = await openDrawer(page, '確認 一');
  await drawer.getByRole('button', { name: /確認 一/ }).click();
  const input = drawer.getByRole('textbox', { name: 'タイトル' });
  await input.fill('書きかけ');

  // 入力欄の中の ] は文字で、移らない
  await input.press(']');
  await expect(input).toHaveValue('書きかけ]');
  await expect(drawer).toBeVisible();
  // 送れない書きかけ（タイトルが空）にしてから移ろうとする
  await input.fill('');

  // ボタンで移ろうとすると確かめる。書き続けると、入力を保ったまま移らない
  await stepButton(drawer, '次').click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '書き続ける' }).click();
  await expect(confirm).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(input).toHaveValue('');

  // 捨てると決めたら、隣のタスクへ移る
  await stepButton(drawer, '次').click();
  await page.getByRole('dialog', { name: '書きかけを捨てますか' }).getByRole('button', { name: '捨てる' }).click();
  const second = page.getByRole('dialog', { name: '確認 二' });
  await expect(second).toBeVisible();
  await expect(second.getByRole('textbox', { name: 'タイトル' })).toHaveCount(0);

  // 日本語の変換中（isComposing か keyCode 229）の [ ] は移らない
  const composing = await page.evaluate(() =>
    [{ isComposing: true }, { keyCode: 229 }].map((init) => {
      const event = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true, ...init });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  expect(composing).toEqual([false, false]);
  await expect(second).toBeVisible();
});

test('行を持たない画面（メンバー）とページ全体では前後のボタンを出さない。狭い幅でも前後のボタンは出る', async ({
  page,
}) => {
  await createWorkspace(page, '前後の範囲ワークスペース');
  await addTaskRow(page, '範囲 一');
  await addTaskRow(page, '範囲 二');
  const taskId = await taskIdOf(page, '範囲 一');
  const workspacePath = new URL(page.url()).pathname;

  // メンバーの画面は行を持たず、順が無いので出さない
  await page.goto(`${workspacePath}/members?task=${taskId}`);
  const onMembers = page.getByRole('dialog', { name: '範囲 一' });
  await expect(onMembers).toBeVisible();
  await expect(stepGroup(onMembers)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(onMembers).toBeHidden();

  // 狭い幅では真ん中を隠すが、前後のボタンは出る
  await page.goto(workspacePath);
  await page.setViewportSize({ width: 390, height: 800 });
  const narrow = await openDrawer(page, '範囲 一');
  await expect(modeButton(narrow, '真ん中')).toHaveCount(0);
  await expect(stepButton(narrow, '次')).toBeVisible();
  await stepButton(narrow, '次').click();
  await expect(page.getByRole('dialog', { name: '範囲 二' })).toBeVisible();

  // ページ全体では出さない
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${workspacePath}/tasks/${taskId}`);
  const pageDrawer = page.locator('.drawer.is-page');
  await expect(pageDrawer).toBeVisible();
  await expect(stepGroup(pageDrawer)).toHaveCount(0);
});

test('ポイントの radio にフォーカスがあっても、[ ] で隣へ移れる', async ({ page }) => {
  await createWorkspace(page, 'radio 前後ワークスペース');
  await addTaskRow(page, '選ぶ 一');
  await addTaskRow(page, '選ぶ 二');
  await addTaskRow(page, '選ぶ 三');
  const drawer = await openDrawer(page, '選ぶ 二');

  // ポイントを選んだ直後は、フォーカスが radio にある
  const radio = drawer.getByRole('radio', { name: '5', exact: true });
  await radio.check();
  await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
  await expect(radio).toBeFocused();

  await page.keyboard.press(']');
  await expect(page.getByRole('dialog', { name: '選ぶ 三' })).toBeVisible();
  await page.getByRole('dialog', { name: '選ぶ 三' }).getByRole('radio', { name: '3', exact: true }).check();
  await expect(
    page.getByRole('dialog', { name: '選ぶ 三' }).getByRole('radio', { name: '3', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('[');
  await expect(page.getByRole('dialog', { name: '選ぶ 二' })).toBeVisible();
});

test('ボタン（クリックと Enter）で移ると、移った先でも同じ向きのボタンにフォーカスがある。端のボタンと、キーで移ったときは見出し', async ({
  page,
}) => {
  await createWorkspace(page, '前後の焦点ワークスペース');
  await addTaskRow(page, '焦点 一');
  await addTaskRow(page, '焦点 二');
  await addTaskRow(page, '焦点 三');
  const first = await openDrawer(page, '焦点 一');

  // クリックで次へ移ると、移った先でも「次の」にフォーカスがあり、続けて Enter で押せる
  await stepButton(first, '次').click();
  const second = page.getByRole('dialog', { name: '焦点 二' });
  await expect(second).toBeVisible();
  await expect(stepButton(second, '次')).toBeFocused();
  await page.keyboard.press('Enter');
  const third = page.getByRole('dialog', { name: '焦点 三' });
  await expect(third).toBeVisible();

  // 端（末尾）で「次の」は押せないので、見出しへ移る
  await expect(stepButton(third, '次')).toHaveAttribute('aria-disabled', 'true');
  await expect(third.getByRole('heading', { level: 2 })).toBeFocused();

  // キー [ で移ったときは、見出しへ移る（ボタンへ戻さない）
  await page.keyboard.press('[');
  await expect(second).toBeVisible();
  await expect(second.getByRole('heading', { level: 2 })).toBeFocused();

  // 前のボタンでも同じ。先頭に着くと見出しへ移る
  await stepButton(second, '前').click();
  await expect(first).toBeVisible();
  await expect(stepButton(first, '前')).toHaveAttribute('aria-disabled', 'true');
  await expect(first.getByRole('heading', { level: 2 })).toBeFocused();
});

test('書きかけを捨てるかの確認を出している間は、] を押しても移らず、確認が残る', async ({ page }) => {
  await createWorkspace(page, '確認中の前後ワークスペース');
  await addTaskRow(page, '確認中 一');
  await addTaskRow(page, '確認中 二');
  const drawer = await openDrawer(page, '確認中 一');
  await drawer.getByRole('button', { name: /確認中 一/ }).click();
  await drawer.getByRole('textbox', { name: 'タイトル' }).fill('');
  await stepButton(drawer, '次').click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか' });
  await expect(confirm).toBeVisible();
  const url = page.url();

  await page.keyboard.press(']');
  await page.keyboard.press('[');
  await expect(confirm).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(page.getByRole('dialog', { name: '確認中 二' })).toHaveCount(0);

  // 書き続けると、そのまま残る
  await confirm.getByRole('button', { name: '書き続ける' }).click();
  await expect(drawer.getByRole('textbox', { name: 'タイトル' })).toHaveValue('');
});

// 計画の画面でスプリントを作り、作ったタスクを入れる
async function createSprint(page: Page, startOn: string, name: string): Promise<void> {
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  await dialog.getByLabel('開始日').fill(startOn);
  await dialog.getByLabel('長さ（日）').fill('14');
  await dialog.getByLabel('名前（任意）').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.lane-title', { hasText: name })).toBeVisible();
}

async function putIntoSprint(page: Page, sprint: string, titles: string[]): Promise<void> {
  await page.getByRole('button', { name: `バックログから入れる: スプリント ${sprint}` }).click();
  const picker = page.getByRole('dialog', { name: `スプリント ${sprint} に入れる` });
  const list = picker.getByRole('group', { name: '入れるタスク' });
  for (const title of titles) await list.getByRole('checkbox', { name: new RegExp(`^${title}`) }).check();
  await picker.getByRole('button', { name: `${titles.length} 件入れる` }).click();
  await expect(picker).toBeHidden();
}

test('計画の画面では、スプリントをまたいで上から下の順に前後へ移る', async ({ page }) => {
  test.setTimeout(90_000);
  await createWorkspace(page, '計画の前後ワークスペース');
  for (const title of ['計画 一', '計画 二', '計画 三']) await addTaskRow(page, title);
  await page.getByRole('link', { name: '計画', exact: true }).click();
  await createSprint(page, '2099-03-01', '第1回');
  await createSprint(page, '2099-03-15', '第2回');
  await putIntoSprint(page, '第1回', ['計画 一', '計画 二']);
  await putIntoSprint(page, '第2回', ['計画 三']);
  await expect(page.locator('.lane-row a')).toHaveText(['計画 一', '計画 二', '計画 三']);

  await page.locator('.lane-row').getByRole('link', { name: '計画 一', exact: true }).click();
  const first = page.getByRole('dialog', { name: '計画 一' });
  await expect(first).toBeVisible();
  await expect(stepButton(first, '前')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press(']');
  await expect(page.getByRole('dialog', { name: '計画 二' })).toBeVisible();
  // 次のスプリントのレーンへ移る
  await page.keyboard.press(']');
  const third = page.getByRole('dialog', { name: '計画 三' });
  await expect(third).toBeVisible();
  await expect(stepButton(third, '次')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('[');
  await expect(page.getByRole('dialog', { name: '計画 二' })).toBeVisible();
  // 閉じると、そのとき開いている行へフォーカスが戻る
  await page.keyboard.press('Escape');
  await expectFocusReturned(page, page.locator('.lane-row').getByRole('link', { name: '計画 二', exact: true }));
});

test('スプリントの画面では、列は左から右、列の中は上から下の順に前後へ移る', async ({ page }) => {
  test.setTimeout(90_000);
  await createWorkspace(page, '盤の前後ワークスペース');
  for (const title of ['盤 一', '盤 二', '盤 三']) await addTaskRow(page, title);
  await page.getByRole('link', { name: '計画' }).click();
  await createSprint(page, '2099-03-01', '第1回');
  await putIntoSprint(page, '第1回', ['盤 一', '盤 二', '盤 三']);
  await page.getByRole('button', { name: '始める: スプリント 第1回' }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める' }).click();
  await expect(start).toBeHidden();
  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 第1回' })).toBeVisible();

  // 盤 一 を右の列（作業中）へ移す。未着手は 盤 二、盤 三、作業中は 盤 一
  const columnTitles = (column: string) =>
    page.getByRole('region', { name: column, exact: true }).locator('.card-title');
  await expect(columnTitles('未着手')).toHaveText(['盤 一', '盤 二', '盤 三']);
  const moved = waitForResponses(page, '/task-column-move');
  await page.getByRole('article', { name: '盤 一', exact: true }).press('Alt+ArrowRight');
  await moved;
  await expect(columnTitles('作業中')).toHaveText(['盤 一']);
  await expect(columnTitles('未着手')).toHaveText(['盤 二', '盤 三']);

  // 先頭のカード（未着手の 盤 二）から ] で進むと、同じ列の下、次の列の順
  await page.getByRole('link', { name: '盤 二', exact: true }).click();
  const second = page.getByRole('dialog', { name: '盤 二' });
  await expect(second).toBeVisible();
  await expect(stepButton(second, '前')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press(']');
  await expect(page.getByRole('dialog', { name: '盤 三' })).toBeVisible();
  await page.keyboard.press(']');
  const last = page.getByRole('dialog', { name: '盤 一' });
  await expect(last).toBeVisible();
  await expect(stepButton(last, '次')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('[');
  await expect(page.getByRole('dialog', { name: '盤 三' })).toBeVisible();
});
