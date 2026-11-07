// 木の空の行: エピックとストーリーを、題を打って Enter だけで作る（#846）。
// 一本道: 最初のストーリーでバックログに木を出す → 木の末尾の「エピックを足す」でエピック → そのエピックの末尾の「ストーリーを足す」で配下のストーリー
// → 木の末尾の「ストーリーを足す」で親のないストーリー。読み直しても同じ位置にある。CSP の違反も確かめる
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { taskCreate } from '../src/shared/operations/task/task-create.ts';
import { addStoryRow, createWorkspace, signIn, watchViolations } from './helpers.ts';
import { AOBA_CLIENT_WORKSPACE_ID, E2E_SEED_TASK_PREFIX, removeE2eSeedTasks } from './local-d1.ts';
import { failOperation } from './operations.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// 木の末尾の空の行（エピックの配下の行は .tree-children の中にあるので、木の直下だけを指す）
function treeTail(page: Page) {
  return page.locator('.tree > .draft-row');
}

function epicGroup(page: Page, title: string) {
  return page.locator('.tree-group', { has: page.getByRole('link', { name: title, exact: true }) });
}

test('エピックとストーリーを、木の空の行に題を打って Enter で作る。作った行は読み直さずに入り、読み直しても同じ場所にある', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, '空の行のワークスペース');

  // 何も無いバックログには木が出ない（空の行は木の末尾にある）。最初の1件は見出しの右の「起票」でタスクを作ると木が出る
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const firstDialog = page.getByRole('dialog', { name: '起票', exact: true });
  await firstDialog.getByLabel('タイトル').fill('最初のタスク');
  await firstDialog.getByRole('button', { name: '起票', exact: true }).click();
  await expect(firstDialog).toBeHidden();

  // 木の末尾の「エピックを足す」。空のまま Enter を押しても何も作らない
  const epicInput = treeTail(page).getByRole('textbox', { name: 'エピックを足す' });
  await epicInput.press('Enter');
  await expect(page.locator('.tree-row.is-epic')).toHaveCount(0);

  // Esc は書きかけを捨てる
  await epicInput.fill('捨てる題');
  await epicInput.press('Escape');
  await expect(epicInput).toHaveValue('');

  await epicInput.fill('会員ポイント制度を公開する');
  await epicInput.press('Enter');
  const epic = epicGroup(page, '会員ポイント制度を公開する');
  await expect(epic).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'エピックを作りました' })).toBeVisible();
  // 作れたら入力は空に戻り、続けて打てる
  await expect(epicInput).toHaveValue('');
  await expect(epicInput).toBeFocused();
  // 欄の案内文に、何を作る行かが出ている
  await expect(epicInput).toHaveAttribute('placeholder', 'エピックを足す（題を打って Enter）');

  // そのエピックの末尾の「ストーリーを足す」。配下の末尾に入る
  const underEpic = epic.getByRole('textbox', { name: 'ストーリーを足す: 会員ポイント制度を公開する' });
  await underEpic.fill('残高を見せる');
  await underEpic.press('Enter');
  await expect(epic.getByRole('link', { name: '残高を見せる', exact: true })).toBeVisible();
  await underEpic.fill('失効日を見せる');
  await underEpic.press('Enter');
  const titles = epic.locator('.tree-row.is-story .tree-title');
  await expect(titles).toHaveText(['残高を見せる', '失効日を見せる']);

  // 木の末尾の「ストーリーを足す」は、親のないストーリーを作る（エピックの配下には入らない）
  const rootInput = treeTail(page).getByRole('textbox', { name: 'ストーリーを足す' });
  await rootInput.fill('親のないストーリー');
  await rootInput.press('Enter');
  await expect(page.getByRole('link', { name: '親のないストーリー', exact: true })).toBeVisible();
  await expect(epic.getByRole('link', { name: '親のないストーリー', exact: true })).toHaveCount(0);

  // 読み直しても、配下の順と親は同じ
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(epicGroup(page, '会員ポイント制度を公開する').locator('.tree-row.is-story .tree-title')).toHaveText([
    '残高を見せる',
    '失効日を見せる',
  ]);
  await expect(
    epicGroup(page, '会員ポイント制度を公開する').getByRole('link', { name: '親のないストーリー', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('link', { name: '親のないストーリー', exact: true })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('タスクを、ストーリーの配下の末尾と木の末尾の空の行に題を打って Enter で作る。2件続けて作ると、2件とも木に出る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'タスクの空の行のワークスペース');

  await addStoryRow(page, '親のストーリー');

  // ストーリーの配下の末尾の「タスクを足す」。空のまま Enter を押しても何も作らない
  const story = page.locator('.tree-group', { has: page.getByRole('link', { name: '親のストーリー', exact: true }) });
  const underStory = story.getByRole('textbox', { name: 'タスクを足す: 親のストーリー' });
  await underStory.press('Enter');
  await expect(story.locator('.entry')).toHaveCount(0);

  // 2件続けて作る。作れたら入力は空に戻り、フォーカスが残る
  await underStory.fill('一つ目のタスク');
  await underStory.press('Enter');
  await expect(story.getByText('一つ目のタスク', { exact: true })).toBeVisible();
  await expect(underStory).toHaveValue('');
  await expect(underStory).toBeFocused();
  await underStory.fill('二つ目のタスク');
  await underStory.press('Enter');
  await expect(story.getByText('二つ目のタスク', { exact: true })).toBeVisible();
  await expect(story.getByText('一つ目のタスク', { exact: true })).toBeVisible();

  // 木の末尾の「タスクを足す」は、親のないタスクを作る
  const rootInput = treeTail(page).getByRole('textbox', { name: 'タスクを足す' });
  await rootInput.fill('親のないタスク');
  await rootInput.press('Enter');
  await expect(page.getByText('親のないタスク', { exact: true })).toBeVisible();
  await expect(story.getByText('親のないタスク', { exact: true })).toHaveCount(0);

  // 読み直しても、親は同じ
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
  await expect(story.getByText('一つ目のタスク', { exact: true })).toBeVisible();
  await expect(story.getByText('二つ目のタスク', { exact: true })).toBeVisible();
  await expect(story.getByText('親のないタスク', { exact: true })).toHaveCount(0);
  expect(await collect()).toEqual([]);
});

// seed の受託開発チームは、完了した親なしのタスクを並びに持つ。その末尾の位置から次の位置を作れず 500 になっていた（#881）。
// seed の行に足すので、前と後に作ったタスクを消して seed の状態へ戻す。題が固定なので、同じテストの複製を並べて走らせない
// （CI の e2e-repeat と同じく --repeat-each は --workers=1。docs/development.md の「e2e の書き方」）
test('seed の受託開発チームで、木の末尾の空の行から親なしのタスクを2件続けて作れ、読み直しても作った順に並ぶ', async ({
  page,
}) => {
  const first = `${E2E_SEED_TASK_PREFIX} 一つ目`;
  const second = `${E2E_SEED_TASK_PREFIX} 二つ目`;
  const collect = await watchViolations(page);
  await removeE2eSeedTasks();
  try {
    await page.goto(`/aoba/w/${AOBA_CLIENT_WORKSPACE_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();

    const rootInput = treeTail(page).getByRole('textbox', { name: 'タスクを足す', exact: true });
    await rootInput.fill(first);
    await rootInput.press('Enter');
    await expect(page.getByText(first, { exact: true })).toBeVisible();
    await expect(rootInput).toHaveValue('');
    await rootInput.fill(second);
    await rootInput.press('Enter');
    await expect(page.getByText(second, { exact: true })).toBeVisible();
    await expect(page.locator('.draft-error')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'バックログ' })).toBeVisible();
    await expect(page.getByText(new RegExp(`^${E2E_SEED_TASK_PREFIX}`))).toHaveText([first, second]);
    expect(await collect()).toEqual([]);
  } finally {
    await removeE2eSeedTasks();
  }
});

test('タスクの空の行が断られたら、理由を出して題を残す。親が完了していたら、トーストで知らせて木を読み直す', async ({
  page,
}) => {
  await createWorkspace(page, 'タスクの空の行が断られるワークスペース');

  await addStoryRow(page, '断られるストーリー');

  const input = page.getByRole('textbox', { name: 'タスクを足す: 断られるストーリー' });

  // 題が使えない（400）。行の下に理由が出て、題が残る
  const unroute = await failOperation(page, taskCreate, { slug: 'aoba' }, 400, 'invalid_input');
  await input.fill('断られる題');
  await input.press('Enter');
  await expect(page.locator('.draft-error')).toBeVisible();
  await expect(input).toHaveValue('断られる題');
  await unroute();

  // 親のストーリーが完了していた（409 の conflict）。トーストで知らせ、題は残る
  await failOperation(page, taskCreate, { slug: 'aoba' }, 409, 'conflict');
  await input.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'タスクを足せません' })).toBeVisible();
  // 題は消えずに残り、行の下にも理由が出る（差し込んだ 409 では親が実際には完了していないので、読み直しても行は消えず、
  // 空の行がフォーカスを取り戻す。行が消えるときの見出しへのフォーカスは、ストーリーの空の行と同じ rowGone が受け持つ）
  await expect(input).toHaveValue('断られる題');
  await expect(page.locator('.draft-error')).toContainText('タスクを足せません');
});
