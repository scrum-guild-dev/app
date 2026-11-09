import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { signIn, findA11yViolations } from './helpers.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { routeOperation, rewriteOperation } from './operations.ts';
import { operationPath, type AnyOperationDefinition, type OutputOf } from '../src/shared/operations/define.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';
import { storyCreate, storyGet } from '../src/shared/operations/story/index.ts';
import { epicCreate } from '../src/shared/operations/epic/index.ts';
import { taskCreate, taskDetail } from '../src/shared/operations/task/index.ts';

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
    expect(entity.body_md).toBe('起票シートの本文です。');
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
  await sheet.getByRole('button', { name: '作る', exact: true }).click();
  expect(sends).toBe(0);
  await sheet.getByLabel('タイトル', { exact: true }).fill('失敗しても残す');
  await sheet.getByLabel('本文', { exact: true }).fill('消さない本文');
  await sheet.getByRole('button', { name: '閉じる', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '書きかけを捨てますか', exact: true });
  await confirm.getByRole('button', { name: '書き続ける', exact: true }).click();
  await expect(sheet.getByLabel('本文', { exact: true })).toHaveValue('消さない本文');
  await sheet.getByRole('button', { name: '作る', exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  await sheet.getByRole('button', { name: '作っています', exact: true }).click();
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
