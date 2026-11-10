import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { SEED_API_TOKENS } from '../seed/api-tokens.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { taskCreate, taskDelete, taskDetail, taskDelegate } from '../src/shared/operations/task/index.ts';
import {
  delegateeList,
  delegateeDelete,
  delegateeUpdate,
  delegateeCreate,
} from '../src/shared/operations/organization/index.ts';

import { failOperation, mockOperation, routeOperation } from './operations.ts';

const workspace = '019a0000-0000-7000-8000-000000000406';

test('自分用の引き出しで依頼先を作成・付け外しし、設定で改名・削除する', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  await signIn(context, baseURL, 'personalAdmin');
  const headers = { Authorization: `Bearer ${SEED_API_TOKENS.personalWrite.token}` };
  const name = `依頼先-${crypto.randomUUID()}`;
  const renamed = `改名-${crypto.randomUUID()}`;
  const created = await request.post(operationPath(taskCreate, 'personal'), {
    headers,
    data: { workspace_id: workspace, title: name },
  });
  expect(created.ok()).toBe(true);
  const { task } = taskCreate.output.parse(await created.json());
  const input = { workspace_id: workspace, task_id: task.id };
  const url = `/personal/w/${workspace}?task=${task.id}`;
  try {
    await page.goto(url);
    const newName = page.getByRole('textbox', { name: '新しい依頼先の名前', exact: true });
    await newName.fill(name);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createCalls = 0;
    const restoreCreate = await routeOperation(page, delegateeCreate, { slug: 'personal' }, async (call) => {
      createCalls++;
      await createGate;
      await call.passThrough();
    });
    const add = page.getByRole('button', { name: `「${name}」を足す`, exact: true });
    try {
      await add.click();
      await expect(add).toHaveAttribute('aria-disabled', 'true');
      await expect.poll(() => createCalls).toBe(1);
      await newName.press('Enter');
      expect(createCalls).toBe(1);
    } finally {
      releaseCreate();
    }
    const select = page.getByRole('dialog').getByRole('combobox', { name: '依頼先', exact: true });
    await expect(select.locator('option:checked')).toHaveText(name);
    await restoreCreate();
    expect(createCalls).toBe(1);
    await expect(newName).toBeFocused();
    const detail = await request.post(operationPath(taskDetail, 'personal'), { headers, data: input });
    const assigned = taskDetail.output.parse(await detail.json()).task.assignee;
    expect(assigned).not.toBeNull();
    await expect(
      page.getByRole('dialog').getByRole('combobox', { name: '担当', exact: true }).locator('option:checked'),
    ).toHaveText(assigned!.name);
    await expect(select).toHaveAttribute('aria-disabled', 'false');
    await page.reload();
    await expect(select.locator('option:checked')).toHaveText(name);
    const restoreList = await failOperation(page, delegateeList, { slug: 'personal' }, 500, 'internal');
    await page.reload();
    const failedField = page.getByRole('dialog').locator('dd').filter({ hasText: '依頼先を読み込めませんでした' });
    await expect(failedField.getByText(name, { exact: true })).toBeVisible();
    await restoreList();
    await failedField.getByRole('button', { name: 'もう一度試す', exact: true }).click();
    await expect(select.locator('option:checked')).toHaveText(name);
    const restore = await failOperation(page, taskDelegate, { slug: 'personal' }, 500, 'internal');
    await select.selectOption('');
    await expect(page.getByRole('alert').filter({ hasText: '依頼先を変更できませんでした' })).toBeVisible();
    await expect(select).toHaveAttribute('aria-disabled', 'false');
    await expect(select.locator('option:checked')).toHaveText(name);
    await restore();
    // 依頼先が消えた場合と、タスクの状態が変わった場合は、タスク詳細も読み直す。
    for (const status of [404, 409]) {
      const restoreConflict = await failOperation(
        page,
        taskDelegate,
        { slug: 'personal' },
        status,
        status === 404 ? 'not_found' : 'conflict',
      );
      const refreshed = page.waitForResponse((response) =>
        response.url().endsWith(operationPath(taskDetail, 'personal')),
      );
      await select.selectOption('');
      await refreshed;
      await expect(
        page.getByRole('alert').filter({ hasText: '依頼先またはタスクの状態が変わった可能性' }),
      ).toBeVisible();
      await expect(select).toHaveAttribute('aria-disabled', 'false');
      await expect(select.locator('option:checked')).toHaveText(name);
      await restoreConflict();
    }
    await select.selectOption('');
    await expect(select.locator('option:checked')).toHaveText('依頼先なし');
    await expect(select).toHaveAttribute('aria-disabled', 'false');
    await select.selectOption({ label: name });
    await expect(select.locator('option:checked')).toHaveText(name);
    await expect(select).toHaveAttribute('aria-disabled', 'false');
    await page.goto('/personal/admin');
    const section = page.getByRole('region', { name: '依頼先', exact: true });
    const row = section.locator('.field').filter({ has: page.getByLabel(name, { exact: true }) });
    await row.getByRole('textbox').fill(renamed);
    await row.getByRole('button', { name: '名前を保存する', exact: true }).click();
    await expect(section.getByRole('textbox', { name: renamed, exact: true })).toBeVisible();
    await page.goto(url);
    await expect(select.locator('option:checked')).toHaveText(renamed);
    await page.goto('/personal/admin');
    await section
      .locator('.field')
      .filter({ has: page.getByLabel(renamed, { exact: true }) })
      .getByRole('button', { name: '削除する', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '依頼先を削除しますか' });
    await expect(dialog).toContainText('未完了のタスクから外します');
    await dialog.getByRole('button', { name: '削除する', exact: true }).click();
    await expect(section.getByRole('textbox', { name: renamed, exact: true })).toHaveCount(0);
    await page.goto(url);
    await expect(select.locator('option:checked')).toHaveText('依頼先なし');
  } finally {
    await request.post(operationPath(taskDelete, 'personal'), { headers, data: input });
    const response = await request.post(operationPath(delegateeList, 'personal'), { headers, data: {} });
    for (const row of delegateeList.output.parse(await response.json()).delegatees) {
      if (row.name === name || row.name === renamed) {
        await request.post(operationPath(delegateeDelete, 'personal'), { headers, data: { delegatee_id: row.id } });
      }
    }
  }
});

test('チーム用の組織の引き出しと設定には依頼先を出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/aoba/admin');
  await expect(page.getByRole('region', { name: '依頼先', exact: true })).toHaveCount(0);
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401');
  // チームのタスクを開いても依頼先の選択欄・新規入力欄はない。
  const link = page.locator('a[data-task-id]').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole('dialog').getByRole('combobox', { name: '担当', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '依頼先', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '新しい依頼先の名前', exact: true })).toHaveCount(0);
});

// 保存対象以外の書きかけと、取り消せる削除確認のフォーカスを保つ。
test('名簿の別行の未保存入力を残し、削除を取り消すと元のボタンへ戻る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'personalAdmin');
  let rows = [
    { id: '019a0000-0000-7000-8000-000000000991', name: '依頼先A' },
    { id: '019a0000-0000-7000-8000-000000000992', name: '依頼先B' },
  ];
  await routeOperation(page, delegateeList, { slug: 'personal' }, (call) => call.fulfill({ delegatees: rows }));
  await routeOperation(page, delegateeUpdate, { slug: 'personal' }, (call) => {
    const row = { id: call.input.delegatee_id, name: call.input.name };
    rows = rows.map((entry) => (entry.id === row.id ? row : entry));
    return call.fulfill({ delegatee: row });
  });
  await mockOperation(page, delegateeDelete, { slug: 'personal' }, { delegatee_id: rows[0].id });
  await page.goto('/personal/admin');
  const section = page.getByRole('region', { name: '依頼先', exact: true });
  await section.getByRole('textbox', { name: '依頼先A', exact: true }).fill('変更したA');
  await section.getByRole('textbox', { name: '依頼先B', exact: true }).fill('編集中のB');
  const saveA = section
    .locator('.field')
    .filter({ has: page.getByLabel('依頼先A', { exact: true }) })
    .getByRole('button', { name: '名前を保存する', exact: true });
  const restoreRename = await failOperation(page, delegateeUpdate, { slug: 'personal' }, 409, 'conflict');
  await saveA.click();
  await expect(section.getByRole('alert')).toContainText('依頼先を更新できませんでした');
  await expect(saveA).toHaveAttribute('aria-disabled', 'false');
  await expect(section.getByRole('textbox', { name: '依頼先A', exact: true })).toHaveValue('変更したA');
  await expect(section.getByRole('textbox', { name: '依頼先B', exact: true })).toHaveValue('編集中のB');
  await restoreRename();
  await saveA.click();
  await expect(section.getByRole('textbox', { name: '変更したA', exact: true })).toBeVisible();
  await expect(section.getByRole('textbox', { name: '依頼先B', exact: true })).toHaveValue('編集中のB');
  const remove = section
    .locator('.field')
    .filter({ has: page.getByLabel('変更したA', { exact: true }) })
    .getByRole('button', { name: '削除する', exact: true });
  await expect(remove).toHaveAttribute('aria-disabled', 'false');
  await remove.click();
  const dialog = page.getByRole('dialog', { name: '依頼先を削除しますか' });
  await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(remove).toBeFocused();
  await expect(section.getByRole('textbox', { name: '依頼先B', exact: true })).toHaveValue('編集中のB');
});

test('空の名簿ではタスクの引き出しから足す方法を案内する', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'personalAdmin');
  await mockOperation(page, delegateeList, { slug: 'personal' }, { delegatees: [] });
  await page.goto('/personal/admin');
  const section = page.getByRole('region', { name: '依頼先', exact: true });
  await expect(section.getByText('依頼先はまだありません', { exact: true })).toBeVisible();
  await expect(section).toContainText('タスクの引き出しで新しい名前を入力すると');
});
