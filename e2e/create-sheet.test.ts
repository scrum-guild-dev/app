import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { signIn, findA11yViolations } from './helpers.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { routeOperation, rewriteOperation } from './operations.ts';
import { operationPath, type AnyOperationDefinition, type OutputOf } from '../src/shared/operations/define.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { storyCreate, storyGet } from '../src/shared/operations/story/index.ts';
import { epicCreate } from '../src/shared/operations/epic/index.ts';
import { backlogTree, taskCreate, taskDetail } from '../src/shared/operations/task/index.ts';

async function create<D extends AnyOperationDefinition>(
  page: Page,
  baseURL: string,
  operation: D,
  input: unknown,
): Promise<OutputOf<D>> {
  const response = await page.request.post(operationPath(operation, 'aoba'), {
    headers: { Origin: new URL(baseURL).origin },
    data: operation.input.parse(input),
  });
  expect(response.status()).toBe(200);
  return operation.output.parse(await response.json()) as OutputOf<D>;
}

async function setup(page: Page, baseURL: string) {
  const { workspace_id } = await create(page, baseURL, workspaceCreate, {
    name: `起票-${crypto.randomUUID().slice(0, 8)}`,
    timezone: 'Asia/Tokyo',
    leader_user_id: '019a0000-0000-7000-8000-000000000301',
  });
  const { epic } = await create(page, baseURL, epicCreate, { workspace_id, title: '起票先のエピック' });
  const { story } = await create(page, baseURL, storyCreate, {
    workspace_id,
    title: '起票先のストーリー',
    epic_id: epic.id,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/aoba/w/${workspace_id}`);
  return { workspace_id, epic, story };
}

for (const kind of ['task', 'story'] as const) {
  test(`390px: ${kind} を本文・属性付きで作り、バックログと詳細へ反映する`, async ({ page, context, baseURL }) => {
    if (!baseURL) throw new Error('baseURL が無い');
    await signIn(context, baseURL, 'admin');
    const target = await setup(page, baseURL);
    // 今日やることからも、直前に開いたメニューのワークスペースへ作る。
    if (kind === 'story')
      await page.locator('.mobile-tabs').getByRole('link', { name: '今日やること', exact: true }).click();
    const trigger = page.getByRole('button', { name: '起票', exact: true });
    await trigger.click();
    const sheet = page.getByRole('dialog', { name: '起票', exact: true });
    await expect(sheet.getByLabel('タイトル', { exact: true })).toBeFocused();
    await expect(sheet.getByRole('button', { name: '作る', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(sheet).toContainText('タイトルを入れてください');
    await sheet.getByRole('button', { name: kind === 'task' ? 'タスク' : 'ストーリー', exact: true }).click();
    const title = `シートで作った${kind}-${crypto.randomUUID().slice(0, 8)}`;
    await sheet.getByLabel('タイトル', { exact: true }).fill(title);
    await sheet.getByLabel('本文', { exact: true }).fill('起票シートの本文です。');
    await sheet.getByRole('button', { name: '引用', exact: true }).click();
    await expect(sheet.getByLabel('本文', { exact: true })).toBeFocused();
    await expect(sheet.getByText('ファイルを選ぶ', { exact: true })).toHaveCount(0);
    if (kind === 'task') {
      const parent = sheet.getByRole('button', { name: /^親のストーリー:/ });
      await expect(parent).not.toHaveAttribute('aria-disabled', 'true');
      await parent.click();
      await sheet.getByRole('menuitemradio', { name: target.story.title, exact: true }).click();
      await sheet.getByRole('button', { name: /^担当:/ }).click();
      await sheet.getByRole('menuitemradio').filter({ hasNotText: 'なし' }).first().click();
      await sheet.getByRole('button', { name: /^ポイント:/ }).click();
      await sheet.getByRole('menuitemradio', { name: '3', exact: true }).click();
    } else {
      const parent = sheet.getByRole('button', { name: /^エピック:/ });
      await expect(parent).not.toHaveAttribute('aria-disabled', 'true');
      await parent.click();
      await sheet.getByRole('menuitemradio', { name: target.epic.title, exact: true }).click();
      await sheet.getByRole('button', { name: /^期日:/ }).click();
      await sheet.locator('input[type=date]').fill('2027-02-20');
      await sheet.locator('.attr-panel').getByRole('button', { name: '閉じる', exact: true }).click();
    }
    expect(await findA11yViolations(page)).toEqual([]);
    const operation = kind === 'task' ? taskCreate : storyCreate;
    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith(operationPath(operation, 'aoba')) && response.request().method() === 'POST',
    );
    await sheet.getByRole('button', { name: '作る', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const created = await response.json();
    const id = kind === 'task' ? created.task.id : created.story.id;
    await expect(sheet).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await page.getByRole('button', { name: '作ったものを開く', exact: true }).click();
    await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
    const detailOperation = kind === 'task' ? taskDetail : storyGet;
    const detail = await page.request.post(operationPath(detailOperation, 'aoba'), {
      headers: { Origin: new URL(baseURL).origin },
      data:
        kind === 'task'
          ? { workspace_id: target.workspace_id, task_id: id }
          : { workspace_id: target.workspace_id, story_id: id },
    });
    expect(detail.status()).toBe(200);
    const data = await detail.json();
    const entity = kind === 'task' ? data.task : data.story;
    expect(entity.body_md).toBe('> 起票シートの本文です。');
    const drawer = page.getByRole('dialog', { name: title, exact: true });
    await expect(drawer.locator('blockquote')).toContainText('起票シートの本文です。');
    await expect(drawer.getByRole('group', { name: '本文の書式' })).toHaveCount(0);
    if (kind === 'task') {
      expect(entity.points).toBe(3);
      expect(entity.story_id).toBe(target.story.id);
      expect(entity.assignee).not.toBeNull();
    } else {
      expect(entity.epic_id).toBe(target.epic.id);
      expect(entity.due_on).toBe('2027-02-20');
    }
    await page
      .getByRole('dialog', { name: title, exact: true })
      .getByRole('button', { name: '閉じる', exact: true })
      .click();
    await expect(
      page.locator(kind === 'task' ? `[data-task-id="${id}"]` : `[data-story-id="${id}"]`).first(),
    ).toContainText(title);
  });
}

test('390px: 書式の付け外しは選択とフォーカスを保ち、44px以上のボタンから続けて書ける', async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  await setup(page, baseURL);
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '起票', exact: true });
  const body = sheet.getByLabel('本文', { exact: true });
  const toolbar = sheet.getByRole('group', { name: '本文の書式' });
  await expect(toolbar.getByRole('button')).toHaveCount(4);
  await body.fill('変換中の本文');
  await body.dispatchEvent('compositionstart');
  await toolbar.getByRole('button', { name: '箇条書き', exact: true }).click();
  await expect(body).toHaveValue('変換中の本文');
  await expect(body).toBeFocused();
  await body.dispatchEvent('compositionend');
  for (const [name, prefix] of [
    ['箇条書き', '- '],
    ['チェックリスト', '- [ ] '],
    ['コード', '```\n'],
    ['引用', '> '],
  ]) {
    const button = toolbar.getByRole('button', { name, exact: true });
    const bounds = await button.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await body.fill('前\n本文\n後');
    await body.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(3, 4));
    await button.click();
    await expect(body).toBeFocused();
    await expect(body).toHaveValue(`前\n${prefix}本文${name === 'コード' ? '\n```' : ''}\n後`);
    await expect
      .poll(() =>
        body.evaluate((input: HTMLTextAreaElement) => input.value.slice(input.selectionStart, input.selectionEnd)),
      )
      .toBe('文');
    // キーボードでボタンを押した場合も、最後の本文の選択を使う。
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(body).toBeFocused();
    await expect(body).toHaveValue('前\n本文\n後');
    await page.keyboard.insertText('続き');
    await expect(body).toHaveValue('前\n本続き\n後');
  }
  await body.fill('一行\n二行\n残す行');
  await body.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 6));
  await toolbar.getByRole('button', { name: 'チェックリスト', exact: true }).click();
  await expect(body).toHaveValue('- [ ] 一行\n- [ ] 二行\n残す行');
  await toolbar.getByRole('button', { name: 'チェックリスト', exact: true }).click();
  await expect(body).toHaveValue('一行\n二行\n残す行');
  await body.fill('');
  await toolbar.getByRole('button', { name: 'コード', exact: true }).click();
  await page.keyboard.insertText('const answer = 42;');
  await expect(body).toHaveValue('```\nconst answer = 42;\n```');
  await toolbar.getByRole('button', { name: 'コード', exact: true }).click();
  await expect(body).toHaveValue('const answer = 42;');
  // 未設定の属性チップはこの変更の対象外。本文欄と書式ボタンの規則を検査する。
  expect(await findA11yViolations(page, '.create-sheet .markdown-editor')).toEqual([]);
});

test('390px: 空・失敗・破棄をやめる・送信中の重複とフォーカス復帰', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  await setup(page, baseURL);
  let sends = 0;
  let release: (() => void) | undefined;
  await routeOperation(page, taskCreate, { slug: 'aoba' }, async (call) => {
    sends++;
    await new Promise<void>((resolve) => (release = resolve));
    await call.fail(500, 'internal');
  });
  const trigger = page.getByRole('button', { name: '起票', exact: true });
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: '起票', exact: true });
  // aria-disabled は Playwright が押下を待ち続けるので、イベントを送り処理側のガードを検査する。
  await sheet.getByRole('button', { name: '作る', exact: true }).dispatchEvent('click');
  expect(sends).toBe(0);
  await sheet.getByLabel('タイトル', { exact: true }).fill('失敗しても残す');
  await sheet.getByLabel('本文', { exact: true }).fill('消さない本文');
  await sheet.getByRole('button', { name: '閉じる', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか', exact: true });
  await confirm.getByRole('button', { name: '書き続ける', exact: true }).click();
  await expect(sheet.getByLabel('本文', { exact: true })).toHaveValue('消さない本文');
  await sheet.getByRole('button', { name: '作る', exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  await sheet.getByRole('button', { name: '作っています', exact: true }).dispatchEvent('click');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeVisible();
  expect(sends).toBe(1);
  release?.();
  await expect(sheet.getByRole('alert')).toContainText('作れませんでした');
  await expect(sheet.getByLabel('タイトル', { exact: true })).toHaveValue('失敗しても残す');
  await sheet.getByRole('button', { name: '閉じる', exact: true }).click();
  await confirm.getByRole('button', { name: '捨てる', exact: true }).click();
  await expect(sheet).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(trigger).not.toBeVisible();
});

test('所属先が無い人には起票の入口を出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.setViewportSize({ width: 390, height: 844 });
  await rewriteOperation(page, organizationInfo, { slug: 'aoba' }, (output) => ({ ...output, workspaces: [] }));
  await page.goto('/aoba');
  await expect(page.getByRole('navigation', { name: 'よく使う画面' })).toBeVisible();
  await expect(page.getByRole('button', { name: '起票', exact: true })).toHaveCount(0);
});

test('画面幅と表示領域が変わっても書きかけと作るボタンを保つ', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  await setup(page, baseURL);
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '起票', exact: true });
  await sheet.getByLabel('タイトル', { exact: true }).fill('幅を変えても残す');
  await page.setViewportSize({ width: 1000, height: 844 });
  await expect(sheet.getByLabel('タイトル', { exact: true })).toHaveValue('幅を変えても残す');
  await page.setViewportSize({ width: 390, height: 300 });
  const submit = sheet.getByRole('button', { name: '作る', exact: true });
  await expect(submit).toBeInViewport();
  await sheet.getByRole('button', { name: '閉じる', exact: true }).click();
  await page
    .getByRole('dialog', { name: '書きかけを捨てますか' })
    .getByRole('button', { name: '捨てる', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '起票', exact: true })).toBeFocused();
});

test('書きかけで戻るのをやめれば残り、捨てて戻った後も進む履歴を保つ', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const { workspace_id } = await setup(page, baseURL);
  await page.locator('.mobile-tabs').getByRole('link', { name: '今日やること', exact: true }).click();
  await expect(page).toHaveURL(new URL('/aoba', baseURL).href);
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '起票', exact: true });
  await sheet.getByLabel('タイトル', { exact: true }).fill('戻る前の書きかけ');
  await page.evaluate(() => history.back());
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか', exact: true });
  await confirm.getByRole('button', { name: '書き続ける', exact: true }).click();
  await expect(sheet.getByLabel('タイトル', { exact: true })).toHaveValue('戻る前の書きかけ');
  await expect(page).toHaveURL(new URL('/aoba', baseURL).href);
  await page.evaluate(() => history.back());
  await confirm.getByRole('button', { name: '捨てる', exact: true }).click();
  await expect(page).toHaveURL(new URL(`/aoba/w/${workspace_id}`, baseURL).href);
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(new URL('/aoba', baseURL).href);
});

for (const [status, code, message] of [
  [400, 'invalid_input', '入力を受け付けられませんでした'],
  [403, 'forbidden', '書き込む権限がありません'],
  [404, 'not_found', '親や担当が見つかりません'],
  [409, 'conflict', '親が完了・中止された可能性があります'],
] as const) {
  test(`起票が ${status} で断られても本文を残し、理由へフォーカスを置く`, async ({ page, context, baseURL }) => {
    if (!baseURL) throw new Error('baseURL が無い');
    await signIn(context, baseURL, 'admin');
    await setup(page, baseURL);
    await routeOperation(page, taskCreate, { slug: 'aoba' }, (call) => call.fail(status, code));
    await page.getByRole('button', { name: '起票', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '起票', exact: true });
    await sheet.getByLabel('タイトル', { exact: true }).fill('失敗時の題');
    await sheet.getByLabel('本文', { exact: true }).fill('残して読み直す本文');
    await sheet.getByRole('button', { name: '作る', exact: true }).click();
    const failure = sheet.getByRole('alert');
    await expect(failure).toContainText(message);
    await expect(failure).toBeFocused();
    await expect(failure).toBeInViewport();
    await expect(sheet.getByLabel('本文', { exact: true })).toHaveValue('残して読み直す本文');
  });
}

test('404 の後で候補から消えた親を解除し、親なしで再送できる', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  const { story } = await setup(page, baseURL);
  let removed = false;
  let releaseChoices = () => {};
  const waitChoices = new Promise<void>((resolve) => {
    releaseChoices = resolve;
  });
  let rechecks = 0;
  let sends = 0;
  await routeOperation(page, backlogTree, { slug: 'aoba' }, async (call) => {
    const output = await call.fetch();
    if (!removed) {
      await call.fulfill(output);
      return;
    }
    rechecks++;
    await waitChoices;
    await call.fulfill({
      ...output,
      stories: output.stories.filter((row) => row.id !== story.id),
      epics: output.epics.map((epic) => ({ ...epic, stories: epic.stories.filter((row) => row.id !== story.id) })),
    });
  });
  await routeOperation(page, taskCreate, { slug: 'aoba' }, async (call) => {
    sends++;
    if (!removed) {
      expect(call.input.story_id).toBe(story.id);
      removed = true;
      await call.fail(404, 'not_found');
    } else {
      expect(call.input.story_id).toBeNull();
      await call.passThrough();
    }
  });
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '起票', exact: true });
  await sheet.getByLabel('タイトル', { exact: true }).fill('親を読み直して作る');
  const parent = sheet.getByRole('button', { name: /^親のストーリー:/ });
  await expect(parent).not.toHaveAttribute('aria-disabled', 'true');
  await parent.click();
  await sheet.getByRole('menuitemradio', { name: story.title, exact: true }).click();
  await sheet.getByRole('button', { name: '作る', exact: true }).click();
  await expect.poll(() => rechecks).toBe(1);
  const submit = sheet.getByRole('button', { name: '作る', exact: true });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await submit.dispatchEvent('click');
  expect(sends).toBe(1);
  releaseChoices();
  await expect(parent).toHaveAccessibleName('親のストーリー: 未設定');
  await sheet.getByRole('button', { name: '作る', exact: true }).click();
  await expect(sheet).not.toBeVisible();
  // 作成後の非同期の再読み込みまで確かめ、route.fetch の途中で context を閉じない。
  await expect(page.getByRole('link', { name: '親を読み直して作る', exact: true })).toBeVisible();
});

test('起票前の本文にファイルを貼る・落とす操作でアップロードせず、本文を保つ', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('baseURL が無い');
  await signIn(context, baseURL, 'admin');
  await setup(page, baseURL);
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/attachment-upload')) uploads.push(request.url());
  });
  await page.getByRole('button', { name: '起票', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '起票', exact: true });
  await sheet.getByLabel('タイトル', { exact: true }).fill('添付せず作る');
  const body = sheet.getByLabel('本文', { exact: true });
  await body.fill('元の本文');
  const prevented = await body.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(['sample'], '架空の画像.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return !element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  expect(prevented).toBe(true);
  await expect(body).toHaveValue('元の本文');
  await sheet.getByRole('button', { name: '作る', exact: true }).click();
  await expect(sheet).not.toBeVisible();
  expect(uploads).toEqual([]);
});
