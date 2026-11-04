import type { Locator, Page } from '@playwright/test';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { commentCreate } from '../src/shared/operations/task/comment.ts';
import { taskUpdate } from '../src/shared/operations/task/task-update.ts';
import { routeOperation } from './operations.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { taskCreate } from '../src/shared/operations/task/task-create.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

// 実際にブラウザで読み込める 1px PNG。サーバーで種類を確かめ、保存後の配信まで通す。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64',
);

async function openTask(page: Page, baseURL: string | undefined): Promise<Locator> {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const title = `添付を確かめる ${crypto.randomUUID()}`;
  // seed の既存タスクには不正な順序キーがあるため、各テスト専用のワークスペースを作る。
  const createdWorkspace = await page.request.post(`/api/aoba/${workspaceCreate.name}`, {
    headers: { Origin: new URL(baseURL).origin },
    data: { name: title, timezone: 'Asia/Tokyo', leader_user_id: '019a0000-0000-7000-8000-000000000301' },
  });
  expect(createdWorkspace.ok()).toBe(true);
  const { workspace_id: workspaceId } = workspaceCreate.output.parse(await createdWorkspace.json());
  const response = await page.request.post(`/api/aoba/${taskCreate.name}`, {
    headers: { Origin: new URL(baseURL).origin },
    data: {
      workspace_id: workspaceId,
      title,
      points: null,
      assignee_user_id: null,
      story_id: null,
      repository_id: null,
      category_id: null,
    },
  });
  expect(response.ok(), `task-create ${response.status()}: ${await response.text()}`).toBe(true);
  const { task } = taskCreate.output.parse(await response.json());
  await page.goto(`/aoba/w/${workspaceId}?task=${task.id}`);
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function addFiles(input: Locator, kind: 'paste' | 'drop', names: string[]): Promise<void> {
  await input.evaluate(
    (element, { kind, names, bytes }) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    },
    { kind, names, bytes: [...PNG] },
  );
}

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

test('本文で複数選択すると画像はカーソルへ入り、画像以外も保存して配信できる', async ({ page, baseURL }) => {
  const drawer = await openTask(page, baseURL);
  await drawer
    .getByText('本文', { exact: true })
    .locator('..')
    .getByRole('button', { name: '編集', exact: true })
    .click();
  const input = drawer.getByRole('textbox', { name: '本文', exact: true });
  await input.fill('前半後半');
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 2));
  const form = input.locator('xpath=ancestor::form');
  const uploadedText = page.waitForResponse(async (response) => {
    if (!response.url().endsWith('/attachment-upload') || response.status() !== 200) return false;
    const row: unknown = await response.json();
    return typeof row === 'object' && row !== null && 'file_name' in row && row.file_name === '手順.txt';
  });
  await form.locator('input[type="file"]').setInputFiles([
    { name: '画面.png', mimeType: 'image/png', buffer: PNG },
    { name: '手順.txt', mimeType: 'text/plain', buffer: Buffer.from('確認の手順') },
  ]);
  const textResponse = await uploadedText;
  const textRow = (await textResponse.json()) as { id: string };
  await expect(input).toHaveValue(/^前半!\[画面\.png\]\(\/api\/aoba\/attachments\/[^)]+\)後半$/);
  await expect(form.getByRole('button', { name: '保存', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(input).toBeHidden();
  const image = drawer.locator('.doc-box img[alt="画面.png"]');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  const text = await page.request.get(`/api/aoba/attachments/${textRow.id}`);
  expect(text.status()).toBe(200);
  expect(await text.text()).toBe('確認の手順');
  await page.reload();
  await expect(drawer.locator('.doc-box img[alt="画面.png"]')).toBeVisible();
});

test('受け入れ基準は複数の貼り付け、コメントは複数のドロップと編集でも画像を保存できる', async ({ page, baseURL }) => {
  const drawer = await openTask(page, baseURL);
  await drawer.getByRole('button', { name: '受け入れ基準を書く', exact: true }).click();
  const field = drawer.getByRole('textbox', { name: '受け入れ基準', exact: true });
  await field.fill('確認する画像:');
  await field.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await addFiles(field, 'paste', ['基準1.png', '基準2.png']);
  await expect(field).toHaveValue(/!\[基準1\.png\].*!\[基準2\.png\]/s);
  const fieldForm = field.locator('xpath=ancestor::form');
  await expect(fieldForm.getByRole('button', { name: '保存', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await fieldForm.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.locator('.doc-box img[alt^="基準"]')).toHaveCount(2);

  const commentInput = drawer.getByRole('textbox', { name: 'コメントを書く', exact: true });
  await commentInput.fill('こちらも確認:');
  await addFiles(commentInput, 'drop', ['コメント1.png', 'コメント2.png']);
  await expect(commentInput).toHaveValue(/!\[コメント1\.png\].*!\[コメント2\.png\]/s);
  await expect(drawer.getByRole('button', { name: '送る', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await drawer.getByRole('button', { name: '送る', exact: true }).click();
  const foundComment = drawer.locator('.comment').filter({ hasText: 'こちらも確認:' });
  await expect(foundComment.locator('img')).toHaveCount(2);
  const commentId = await foundComment.getAttribute('data-comment');
  const comment = drawer.locator(`[data-comment="${commentId}"]`);
  await comment.getByRole('button', { name: '編集', exact: true }).click();
  const edit = comment.getByRole('textbox', { name: 'コメントを直す', exact: true });
  await addFiles(edit, 'paste', ['追記.png']);
  await expect(edit).toHaveValue(/!\[追記\.png\]/);
  await expect(comment.getByRole('button', { name: '保存', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await comment.getByRole('button', { name: '保存', exact: true }).click();
  await expect(comment.locator('img')).toHaveCount(3);
});

test('保存時に未添付のファイルが消えていても、本文と引き出しを残して再追加できる', async ({ page, baseURL }) => {
  const drawer = await openTask(page, baseURL);
  await drawer
    .getByText('本文', { exact: true })
    .locator('..')
    .getByRole('button', { name: '編集', exact: true })
    .click();
  const input = drawer.getByRole('textbox', { name: '本文', exact: true });
  await input.fill('残しておく本文');
  const form = input.locator('xpath=ancestor::form');
  await form.locator('input[type="file"]').setInputFiles({ name: '再追加.png', mimeType: 'image/png', buffer: PNG });
  await expect(input).toHaveValue(/!\[再追加\.png\]/);
  const draft = await input.inputValue();
  const unroute = await routeOperation(page, taskUpdate, { slug: 'aoba' }, async (call) => {
    await call.fail(404, 'not_found', { details: { attachment_ids: call.input.attachment_ids } });
  });
  await expect(form.getByRole('button', { name: '保存', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('もう一度追加');
  await expect(drawer).toBeVisible();
  await expect(input).toHaveValue(draft);
  await expect(input).toBeFocused();
  await unroute();
  await form.locator('input[type="file"]').setInputFiles({ name: '再追加.png', mimeType: 'image/png', buffer: PNG });
  await expect(input).not.toHaveValue(draft);
  await expect(form.getByRole('button', { name: '保存', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(input).toBeHidden();
  await expect(drawer.locator('.doc-box').filter({ hasText: '残しておく本文' })).toBeVisible();
});

// routeOperation は JSON 入力専用なので、バイナリのアップロードだけ定義から URL を作って差し替える。
test('組織の上限では残りの追加を止め、管理者への依頼を示す', async ({ page, baseURL }) => {
  const drawer = await openTask(page, baseURL);
  const input = drawer.getByRole('textbox', { name: 'コメントを書く', exact: true });
  const form = input.locator('xpath=ancestor::form');
  let requests = 0;
  await page.route(`**${operationPath(attachmentUpload, 'aoba')}`, async (route) => {
    requests++;
    await route.fulfill({ status: 409, json: { error: { code: 'attachment_quota_exceeded', message: '' } } });
  });
  await form.locator('input[type="file"]').setInputFiles([
    {
      name: '非常に長いファイル名でも全文を読めるように確かめる添付ファイルの画面.png',
      mimeType: 'image/png',
      buffer: PNG,
    },
    { name: '二枚目.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(form.getByRole('button', { name: 'ファイルを選ぶ', exact: true })).toBeDisabled();
  await expect(form).toContainText('管理者');
  await expect(form.locator('.file-row.is-error')).toHaveCount(2);
  expect(requests).toBe(1);
  // 上限後もブラウザ自身のファイル表示へ移動させず、追加せずに欄を残す。
  for (const target of [input, form.locator('.dropzone')]) {
    const prevented = await target.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['extra'], '追加.txt'));
      const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
  }
  expect(requests).toBe(1);
  await expect(form.locator('.file-row')).toHaveCount(2);
  await expect(input).toHaveValue('');
  for (const width of [320, 390, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(form.locator('.file-name').first()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() => form.locator('.markdown-editor').evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    if (width === 390) {
      await form.scrollIntoViewIfNeeded();
      await test.info().attach('markdown-editor-390', {
        body: await form.screenshot(),
        contentType: 'image/png',
      });
    }
  }
});

test('アップロード中は送信を止め、ファイルをやめても本文を保つ', async ({ page, baseURL }) => {
  const drawer = await openTask(page, baseURL);
  const input = drawer.getByRole('textbox', { name: 'コメントを書く', exact: true });
  const form = input.locator('xpath=ancestor::form');
  await input.fill('書いている途中の文');
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${operationPath(attachmentUpload, 'aoba')}`, async (route) => {
    started = true;
    await gate;
    await route
      .fulfill({
        status: 200,
        json: {
          id: crypto.randomUUID(),
          file_name: '途中.png',
          content_type: 'image/png',
          size_bytes: PNG.length,
          created_at: new Date().toISOString(),
        },
      })
      .catch(() => {});
  });
  try {
    await form.locator('input[type="file"]').setInputFiles({ name: '途中.png', mimeType: 'image/png', buffer: PNG });
    await expect.poll(() => started).toBe(true);
    await expect(form.getByRole('button', { name: '送る', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(form.getByRole('progressbar', { name: '途中.png' })).toBeVisible();
    await form.getByRole('button', { name: '途中.png のアップロードをやめる', exact: true }).click();
    release();
    await expect(form.getByRole('progressbar')).toHaveCount(0);
    await expect(form.getByRole('button', { name: '送る', exact: true })).toHaveAttribute('aria-disabled', 'false');
    await expect(input).toHaveValue('書いている途中の文');
    let sending = false;
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await routeOperation(page, commentCreate, { slug: 'aoba' }, async (call) => {
      sending = true;
      await saveGate;
      await call.passThrough();
    });
    try {
      await form.getByRole('button', { name: '送る', exact: true }).click();
      await expect.poll(() => sending).toBe(true);
      await expect(input).toHaveAttribute('readonly', '');
      for (const target of [input, form.locator('.dropzone')]) {
        const prevented = await target.evaluate((element) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(['extra'], '保存中.txt'));
          const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        });
        expect(prevented).toBe(true);
      }
      await expect(input).toHaveValue('書いている途中の文');
      releaseSave();
      await expect(input).toHaveValue('');
    } finally {
      releaseSave();
    }
  } finally {
    release();
  }
});

test('50 MBを超えるファイルは送らず、ファイルごとの容量と理由を示す', async ({ page, baseURL }) => {
  const drawer = await openTask(page, baseURL);
  const input = drawer.getByRole('textbox', { name: 'コメントを書く', exact: true });
  let requests = 0;
  await page.route(`**${operationPath(attachmentUpload, 'aoba')}`, async (route) => {
    requests++;
    await route.abort();
  });
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(52_428_801)], '大きい録画.mp4', { type: 'video/mp4' }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  const row = drawer.locator('.file-row', { hasText: '大きい録画.mp4' });
  await expect(row.getByRole('alert')).toContainText('50.00 MB');
  await expect(row.getByRole('alert')).toContainText('上限50 MB');
  expect(requests).toBe(0);
});
