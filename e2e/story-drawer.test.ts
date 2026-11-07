// ストーリーの引き出し（`?story=<ID>`）: 受け入れ基準を書いて欄を離れると保存され、開き直しても読み直しても残る。
// 書いてすぐ戻っても元のストーリーに保存される。
// ほかの人が先に同じ欄（期日も）を直していたら、保存せずに知らせ、書いた分が残る。引き出しから完了にする、取り消す、親を移す。
// 親なしへ移すと区分を選べる。
// 前後のストーリーへ移る。タスクの引き出しと同時には開かない。開き方は横と真ん中だけ。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。CSP の違反も確かめる。
// 書き換える確かめは、作ったワークスペースで行う（seed の行は書き換えない）。開くだけの確かめは seed のワークスペースを使う
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { categoryCreate } from '../src/shared/operations/definition/category.ts';
import { storyGet } from '../src/shared/operations/story/story-get.ts';
import { storyUpdate } from '../src/shared/operations/story/story-update.ts';
import { createWorkspace, signIn, waitForResponses, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

const SEED_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
// seed のストーリー。木の順は、エピックの下の「送料の割引にポイントを使える」、親のない「ポイントの付与…」、「問い合わせの一次回答…」
const SEED_TASK_ID = '019a0000-0000-7000-8000-000000000801';
const SEED_TASK_TITLE = 'ポイント付与のバッチを作る';
const SEED_STORY_TITLES = [
  '送料の割引にポイントを使える',
  'ポイントの付与と失効を管理画面で確かめられる',
  '問い合わせの一次回答を早くする',
] as const;

// 本物の API へ、別の経路（別の人）から書く。Origin を付けないと CSRF の検査で断られる
async function post(page: Page, baseURL: string, operation: Parameters<typeof operationPath>[0], data: object) {
  return page.request.post(operationPath(operation, 'aoba'), {
    headers: { Origin: new URL(baseURL).origin, 'Content-Type': 'application/json' },
    data,
  });
}

// 作った後は、木の読み直しが返るまで待つ。読み直しで木が替わると、画面は画面だけで足した行を捨てる（+page.svelte）
async function create(page: Page, label: string, title: string, fields: Record<string, string> = {}): Promise<void> {
  await page.getByRole('button', { name: label }).click();
  const dialog = page.getByRole('dialog', { name: label });
  await dialog.getByLabel('タイトル').fill(title);
  for (const [name, value] of Object.entries(fields)) await dialog.getByLabel(name).fill(value);
  const reloaded = waitForResponses(page, '/backlog-tree');
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
}

// 木の題のリンクでストーリーの引き出しを開く。読み込みが終わり、題が引き出しの名前になるまで待つ
async function openStory(page: Page, title: string) {
  await page.getByRole('link', { name: title, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  return drawer;
}

test('受け入れ基準を押して書き、欄を離れると保存され、閉じて開き直しても、読み直しても残る', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '基準を書くワークスペース');
  await create(page, 'ストーリーを作る', '残高を確かめられる');

  const drawer = await openStory(page, '残高を確かめられる');
  await expect(page).toHaveURL(/\?story=[0-9a-f-]{36}$/);
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  // 書いていない受け入れ基準は「まだ書かれていません」。押すと書く欄になり、「保存」のボタンは無い
  await expect(drawer.locator('.doc-box.is-empty')).toHaveCount(2);
  await drawer.getByRole('button', { name: '受け入れ基準を書く' }).click();
  const criteria = drawer.getByRole('textbox', { name: '受け入れ基準' });
  await expect(criteria).toBeFocused();
  await expect(drawer.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);

  // 欄を離れると保存され、読む形に戻って、Markdown の箇条書きが描かれる
  const updated = waitForResponses(page, '/story-update');
  await criteria.fill('- 残高が見える\n- 失効日が分かる');
  await criteria.blur();
  await updated;
  await expect(drawer.getByRole('listitem').filter({ hasText: '残高が見える' })).toBeVisible();
  await expect(drawer.getByRole('listitem').filter({ hasText: '失効日が分かる' })).toBeVisible();
  await expect(drawer.getByRole('status').filter({ hasText: '保存しました' }).first()).toBeVisible();

  // 閉じて、開き直しても残る。閉じたら URL から story が外れ、フォーカスは題のリンクへ戻る
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/\?story=/);
  await expect(page.getByRole('link', { name: '残高を確かめられる', exact: true })).toBeFocused();
  const reopened = await openStory(page, '残高を確かめられる');
  await expect(reopened.getByRole('listitem').filter({ hasText: '残高が見える' })).toBeVisible();

  // 読み直しても同じ。URL の ?story= だけで引き出しが開く
  await page.reload();
  const reloaded = page.getByRole('dialog', { name: '残高を確かめられる', exact: true });
  await expect(reloaded.getByRole('listitem').filter({ hasText: '失効日が分かる' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('手を止めると書いている途中でも保存され、本文の Markdown に含めた script は動かない', async ({ page }) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '自動保存のワークスペース');
  await create(page, 'ストーリーを作る', '手を止めて保存する');

  const drawer = await openStory(page, '手を止めて保存する');
  await drawer.getByRole('button', { name: '本文を書く' }).click();
  const body = drawer.getByRole('textbox', { name: '本文' });
  const updated = waitForResponses(page, '/story-update');
  await body.fill('# 手順\n\n<script>window.__injected = true</script>');
  // 欄は離れない。手を止めて少したつと保存される
  await updated;
  await expect(drawer.getByRole('status').filter({ hasText: '保存しました' }).first()).toBeVisible();
  await expect(body).toBeFocused();
  await body.blur();
  const rendered = drawer.locator('.doc-box');
  await expect(rendered.getByRole('heading', { level: 3, name: '手順' })).toBeVisible();
  await expect(rendered.getByText('<script>window.__injected = true</script>')).toBeVisible();
  await expect(rendered.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
  expect(await collect()).toEqual([]);
});

test('ほかの人が先に同じ欄を直していたら、保存せずに今の値を知らせ、書いた分は欄に残る。続けて書くと上書きする', async ({
  page,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await createWorkspace(page, '先に直されるワークスペース');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  await create(page, 'ストーリーを作る', '先に直される', { 受け入れ基準: '- 元の基準' });
  const storyId = (await page.getByRole('link', { name: '先に直される', exact: true }).getAttribute('data-story-id'))!;
  const drawer = await openStory(page, '先に直される');

  // 書き始めた後に、ほかの人が同じ欄を直した形にする（本物の API へ、別の経路から書く）
  await drawer.getByRole('button', { name: '受け入れ基準を書く' }).click();
  const criteria = drawer.getByRole('textbox', { name: '受け入れ基準' });
  await expect(criteria).toHaveValue('- 元の基準');
  const other = await page.request.post(operationPath(storyUpdate, 'aoba'), {
    headers: { Origin: new URL(baseURL).origin, 'Content-Type': 'application/json' },
    data: { workspace_id: workspaceId, story_id: storyId, acceptance_criteria_md: '- 先に直された基準' },
  });
  expect(other.status()).toBe(200);

  // 自分が書いた分は送らずに断られ、今の値が知らされる。書いた分は欄に残り、保存された値は先に直された方のまま
  const requests: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(operationPath(storyUpdate, 'aoba'))) requests.push(request.postDataJSON());
  });
  await criteria.fill('- 自分が書いた基準');
  await criteria.blur();
  const alert = drawer.getByRole('alert').filter({ hasText: 'ほかの人が先に直しました' });
  await expect(alert).toContainText('今の内容は「- 先に直された基準」です');
  await expect(alert).toContainText('書いた内容は残してあります');
  await expect(criteria).toHaveValue('- 自分が書いた基準');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    acceptance_criteria_md: '- 自分が書いた基準',
    expected: { acceptance_criteria_md: '- 元の基準' },
  });
  const current = await page.request.post(operationPath(storyGet, 'aoba'), {
    headers: { Origin: new URL(baseURL).origin, 'Content-Type': 'application/json' },
    data: { workspace_id: workspaceId, story_id: storyId },
  });
  expect(((await current.json()) as { story: { acceptance_criteria_md: string } }).story.acceptance_criteria_md).toBe(
    '- 先に直された基準',
  );

  // 続けて書くと、今の値を読んだものとして送るので、書いた内容で上書きされる
  const saved = waitForResponses(page, '/story-update');
  await criteria.fill('- 読んだ上で書き直した基準');
  await saved;
  await expect(alert).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ expected: { acceptance_criteria_md: '- 先に直された基準' } });
  await criteria.blur();
  await expect(drawer.getByRole('listitem').filter({ hasText: '読んだ上で書き直した基準' })).toBeVisible();
});

test('書いて1.5秒待たずに戻っても、元のストーリーに保存され、URL が戻る。開き直すと書いた本文が残る', async ({
  page,
}) => {
  await createWorkspace(page, '戻るワークスペース');
  await create(page, 'ストーリーを作る', '戻る前に書く');
  await create(page, 'ストーリーを作る', '別のストーリー');
  const storyId = (await page.getByRole('link', { name: '戻る前に書く', exact: true }).getAttribute('data-story-id'))!;
  const requests: { story_id?: string; body_md?: string }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(operationPath(storyUpdate, 'aoba'))) requests.push(request.postDataJSON());
  });
  const drawer = await openStory(page, '戻る前に書く');
  await drawer.getByRole('button', { name: '本文を書く' }).click();
  const body = drawer.getByRole('textbox', { name: '本文' });

  // 手を止めて保存されるのを待たずに、戻る（ブラウザの戻る。Alt+← と同じ）。部品が外れるときに、書きかけを送る
  const saved = waitForResponses(page, '/story-update');
  await body.fill('戻る前に書いた本文');
  await page.goBack();
  await expect(page).not.toHaveURL(/\?story=/);
  await expect(drawer).toBeHidden();
  expect((await saved).status()).toBe(200);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ story_id: storyId, body_md: '戻る前に書いた本文' });
  await expect(page.getByRole('status').filter({ hasText: '保存しました' }).first()).toBeVisible();

  // 元のストーリーに書かれている（別のストーリーには書かれていない）
  const reopened = await openStory(page, '戻る前に書く');
  await expect(reopened.getByText('戻る前に書いた本文')).toBeVisible();
  await page.keyboard.press('Escape');
  const other = await openStory(page, '別のストーリー');
  await expect(other.locator('.doc-box.is-empty')).toHaveCount(2);
});

test('ほかの人が先に期日を直していたら、期日の保存は断られ、入力欄に自分の値が残る。Enter で上書きする', async ({
  page,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await createWorkspace(page, '期日が先に直されるワークスペース');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  await create(page, 'ストーリーを作る', '期日を先に直される');
  const storyId = (await page
    .getByRole('link', { name: '期日を先に直される', exact: true })
    .getAttribute('data-story-id'))!;
  const drawer = await openStory(page, '期日を先に直される');
  const due = drawer.getByLabel('期日');
  await expect(due).toHaveValue('');

  // 開いた後に、ほかの人が期日を入れた形にする
  const other = await post(page, baseURL, storyUpdate, {
    workspace_id: workspaceId,
    story_id: storyId,
    due_on: '2030-04-01',
  });
  expect(other.status()).toBe(200);

  // 書き始める前の値（なし）を添えて送り、断られる。書いた値は欄に残り、保存された値は先に直された方のまま
  const requests: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(operationPath(storyUpdate, 'aoba'))) requests.push(request.postDataJSON());
  });
  await due.fill('2030-05-06');
  const alert = drawer.getByRole('alert').filter({ hasText: 'ほかの人が先に直しました' });
  await expect(alert).toContainText('今の内容は「2030-04-01」です');
  await expect(alert).toContainText('書いた内容は残してあります');
  await expect(due).toHaveValue('2030-05-06');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ due_on: '2030-05-06', expected: { due_on: null } });
  const current = await post(page, baseURL, storyGet, { workspace_id: workspaceId, story_id: storyId });
  expect(((await current.json()) as { story: { due_on: string } }).story.due_on).toBe('2030-04-01');

  // 欄を離れても、断られた値のままでは送り直さない
  await due.blur();
  await expect(due).toHaveValue('2030-05-06');
  expect(requests).toHaveLength(1);

  // 今の値を読んだ上で Enter を押すと、今の値を読んだものとして送るので、書いた値で上書きされる
  const saved = waitForResponses(page, '/story-update');
  await due.press('Enter');
  await saved;
  await expect(alert).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ due_on: '2030-05-06', expected: { due_on: '2030-04-01' } });
  await expect(due).toHaveValue('2030-05-06');
});

test('引き出しから「完了にする」と「取り消す」ができる。未完了のタスクが残るあいだは押せず、理由を添える', async ({
  page,
}) => {
  await createWorkspace(page, '完了のワークスペース');
  await create(page, 'ストーリーを作る', '配下のあるストーリー');
  await create(page, 'ストーリーを作る', '配下のないストーリー');
  await page.getByRole('button', { name: 'タスクを足す: 配下のあるストーリー' }).click();
  const taskDialog = page.getByRole('dialog', { name: '起票' });
  await taskDialog.getByLabel('タイトル').fill('残っているタスク');
  await taskDialog.getByRole('button', { name: '起票' }).click();
  await expect(taskDialog).toBeHidden();

  // 配下に未完了のタスクが残るあいだは、押しても何も起きず、理由が読み上げと一緒に出る
  const blocked = await openStory(page, '配下のあるストーリー');
  const complete = blocked.getByRole('button', { name: '完了にする' });
  await expect(complete).toHaveAttribute('aria-disabled', 'true');
  await expect(blocked.getByText('残り 1 件のタスク')).toBeVisible();
  await expect(complete).toHaveAccessibleDescription(/残り 1 件のタスク/);
  await complete.click();
  await expect(blocked.getByRole('img', { name: '完了' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(blocked).toBeHidden();

  // 配下の無いストーリーは完了にできる。完了の印と日時が出て、木の行にも完了の印が付き、フォーカスは印へ移る
  const drawer = await openStory(page, '配下のないストーリー');
  const completed = waitForResponses(page, '/story-complete');
  await drawer.getByRole('button', { name: '完了にする' }).click();
  await completed;
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーを完了にしました' })).toBeVisible();
  const mark = drawer.getByRole('img', { name: '完了' });
  await expect(mark).toBeFocused();
  await expect(drawer.getByText(/^完了 \d{4}/)).toBeVisible();
  await expect(drawer.locator('.chip.is-ok')).toHaveText('完了');
  await expect(
    page
      .locator('.tree-group', { has: page.getByRole('link', { name: '配下のないストーリー', exact: true }) })
      .locator('.hanko'),
  ).toBeVisible();

  // 取り消すと、「完了にする」へ戻り、フォーカスもそこへ移る
  const reopened = waitForResponses(page, '/story-reopen');
  await drawer.getByRole('button', { name: /完了を取り消す/ }).click();
  await reopened;
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーの完了を取り消しました' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: '完了にする' })).toBeFocused();
  await expect(drawer.getByRole('img', { name: '完了' })).toHaveCount(0);
});

test('引き出しの「⋯」から親を移すと、木でその親の下に並ぶ', async ({ page }) => {
  await createWorkspace(page, '親を移すワークスペース');
  await create(page, 'エピックを作る', '会員証を作り直す');
  await create(page, 'ストーリーを作る', '移されるストーリー');

  const drawer = await openStory(page, '移されるストーリー');
  const menu = drawer.getByRole('button', { name: '操作: 移されるストーリー', exact: true });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  // 開くと最初の項目へフォーカスが移り、Esc で閉じて「⋯」へ戻る（引き出しは閉じない）
  await expect(drawer.getByRole('menuitem', { name: '親を移す' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer).toBeVisible();

  await menu.click();
  await drawer.getByRole('menuitem', { name: '親を移す' }).click();
  const dialog = page.getByRole('dialog', { name: '「移されるストーリー」の親を移す' });
  await dialog.getByLabel('移す先').selectOption({ label: '会員証を作り直す' });
  const moved = waitForResponses(page, '/story-move');
  await dialog.getByRole('button', { name: '移す' }).click();
  await moved;
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'ストーリーの親を移しました' })).toBeVisible();
  // 引き出しは開いたまま。エピックの下のストーリーは、区分をエピックから引き継ぐ（親から引き継ぎ）
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('親から引き継ぎ')).toBeVisible();
  await expect(
    page
      .locator('.tree-group', { has: page.getByRole('link', { name: '会員証を作り直す', exact: true }) })
      .locator('.tree-children .tree-row.is-story a.tree-link'),
  ).toHaveText(['移されるストーリー']);
});

test('「[」と「]」で前後のストーリーへ移り、端では止まる。開き方は横と真ん中だけ', async ({ page }) => {
  await page.goto(SEED_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  const first = await openStory(page, SEED_STORY_TITLES[0]);

  // 開き方にページ全体と新しいタブは無い
  await expect(first.getByRole('group', { name: '開き方' }).getByRole('button')).toHaveText(['横', '真ん中']);
  await expect(first.getByRole('group', { name: '前後のストーリー' })).toBeVisible();
  await expect(first.getByRole('button', { name: '前のストーリー' })).toHaveAttribute('aria-disabled', 'true');

  // 木の順に移る。URL の story だけが替わる
  await page.keyboard.press(']');
  const second = page.getByRole('dialog', { name: SEED_STORY_TITLES[1], exact: true });
  await expect(second).toBeVisible();
  await expect(page).toHaveURL(/\?story=[0-9a-f-]{36}$/);
  await expect(second.getByRole('heading', { level: 2 })).toBeFocused();
  await page.keyboard.press(']');
  const third = page.getByRole('dialog', { name: SEED_STORY_TITLES[2], exact: true });
  await expect(third).toBeVisible();
  // 最後では次へ移れない
  await expect(third.getByRole('button', { name: '次のストーリー' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press(']');
  await expect(third).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('dialog', { name: SEED_STORY_TITLES[1], exact: true })).toBeVisible();

  // ボタンで移ると、押したのと同じ向きのボタンにフォーカスが残り、移った先の題が読み上げられる
  await page
    .getByRole('dialog', { name: SEED_STORY_TITLES[1], exact: true })
    .getByRole('button', { name: '次のストーリー' })
    .click();
  const last = page.getByRole('dialog', { name: SEED_STORY_TITLES[2], exact: true });
  await expect(last).toBeVisible();
  await expect(
    last.getByRole('status').filter({ hasText: `ストーリー「${SEED_STORY_TITLES[2]}」に移りました` }),
  ).toHaveCount(1);
});

test('ストーリーとタスクの引き出しは同時に開かない。片方を開くともう片方の問い合わせを外す', async ({ page }) => {
  await page.goto(SEED_WORKSPACE);
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();

  // 両方が付いた URL は、タスクの引き出しだけを開く
  await page.goto(`${SEED_WORKSPACE}?story=019a0000-0000-7000-8000-000000000901&task=${SEED_TASK_ID}`);
  const task = page.getByRole('dialog', { name: SEED_TASK_TITLE, exact: true });
  await expect(task).toBeVisible();
  await expect(page.locator('.drawer')).toHaveCount(1);
  await page.goto(SEED_WORKSPACE);
  await expect(page.locator('.drawer')).toHaveCount(0);

  // 行のリンクは、もう一方の問い合わせを外す。ストーリーの題のリンクに task は付かず、タスクのリンクに story は付かない
  const storyLink = page.getByRole('link', { name: SEED_STORY_TITLES[1], exact: true });
  expect(await storyLink.getAttribute('href')).toMatch(/\?story=[0-9a-f-]{36}$/);
  const taskLink = page.getByRole('link', { name: SEED_TASK_TITLE, exact: true });
  expect(await taskLink.getAttribute('href')).toMatch(/\?task=[0-9a-f-]{36}$/);
  await storyLink.click();
  await expect(page.getByRole('dialog', { name: SEED_STORY_TITLES[1], exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  await taskLink.click();
  await expect(page.getByRole('dialog', { name: SEED_TASK_TITLE, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?task=[0-9a-f-]{36}$/);
  await expect(page.locator('.drawer')).toHaveCount(1);
});

test('存在しないストーリーの ID で開くと、トーストで知らせて閉じる', async ({ page }) => {
  await createWorkspace(page, '見つからないワークスペース');
  const url = new URL(page.url());
  await page.goto(`${url.pathname}?story=019a0000-0000-7000-8000-00000000ffff`);
  await expect(page.getByRole('status').filter({ hasText: 'このストーリーは見つかりません' })).toBeVisible();
  await expect(page).not.toHaveURL(/\?story=/);
  await expect(page.locator('.drawer')).toHaveCount(0);
});

test('ストーリーとタスクの両方が付いた URL でタスクを閉じると、ストーリーの引き出しは開かず、URL から両方が外れる', async ({
  page,
}) => {
  await page.goto(`${SEED_WORKSPACE}?story=019a0000-0000-7000-8000-000000000901&task=${SEED_TASK_ID}`);
  const task = page.getByRole('dialog', { name: SEED_TASK_TITLE, exact: true });
  await expect(task).toBeVisible();
  await task.locator('.drawer-close').click();
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&](story|task)=/);
});

test('親なしへ移した後は、区分の選択欄が読み込まれていて、区分を選んで保存できる', async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await createWorkspace(page, '親なしへ戻すワークスペース');
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  const made = await post(page, baseURL, categoryCreate, { workspace_id: workspaceId, name: '保守' });
  expect(made.status()).toBe(200);
  await create(page, 'エピックを作る', '会員証を作り直す');
  await create(page, 'ストーリーを作る', '親なしへ戻るストーリー');

  // エピックの下へ移してから開く。親のあるストーリーは区分の選択肢を読まない
  await page.getByRole('button', { name: '親を移す: 親なしへ戻るストーリー' }).click();
  const rowDialog = page.getByRole('dialog', { name: '「親なしへ戻るストーリー」の親を移す' });
  const rowMoved = waitForResponses(page, '/story-move');
  await rowDialog.getByRole('button', { name: '移す' }).click();
  await rowMoved;
  await expect(rowDialog).toBeHidden();
  const drawer = await openStory(page, '親なしへ戻るストーリー');
  await expect(drawer.getByText('親から引き継ぎ')).toBeVisible();
  await expect(drawer.getByLabel('区分')).toHaveCount(0);

  // 引き出しの「⋯」から親なしへ移すと、区分の選択肢を読み、選べる
  await drawer.getByRole('button', { name: '操作: 親なしへ戻るストーリー', exact: true }).click();
  await drawer.getByRole('menuitem', { name: '親を移す' }).click();
  const dialog = page.getByRole('dialog', { name: '「親なしへ戻るストーリー」の親を移す' });
  await dialog.getByLabel('移す先').selectOption({ label: '親なし' });
  const moved = waitForResponses(page, '/story-move');
  await dialog.getByRole('button', { name: '移す' }).click();
  await moved;
  const select = drawer.getByLabel('区分');
  await expect(select).toBeVisible();
  await expect(select.getByRole('option', { name: '保守' })).toHaveCount(1);
  const saved = waitForResponses(page, '/story-update');
  await select.selectOption({ label: '保守' });
  await select.blur();
  await saved;
  await expect(select.locator('option:checked')).toHaveText('保守');
});
