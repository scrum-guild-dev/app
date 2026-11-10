// バックログの依頼先のチップと絞り込み（#907）。自分用の組織だけに出す。
// 自分用の組織（seed の personal）: 依頼先の付いた行にだけチップが出る → チップで別の人を選び直す → 帯の「依頼先」で絞り、
// URL に残って再読み込みしても残る → 「依頼先なし」で絞る → チップで外すとチップが消え、フォーカスはタイトルへ移る。
// チーム用の組織（あおば開発）: 帯にも行にも依頼先を出さない。
// 名簿とタスクは毎回 API で作り、後で消す（seed の行と、並べて走る e2e/delegatee.test.ts の行は変えない）
import type { APIRequestContext } from '@playwright/test';
import { SEED_API_TOKENS } from '../seed/api-tokens.ts';
import {
  operationPath,
  type AnyOperationDefinition,
  type InputOf,
  type OutputOf,
} from '../src/shared/operations/define.ts';
import { delegateeCreate, delegateeDelete } from '../src/shared/operations/organization/index.ts';
import { taskCreate, taskDelegate, taskDelete, taskDetail } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn, waitForResponses, watchViolations } from './helpers.ts';

const PERSONAL_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000406';
const PERSONAL_BACKLOG = `/personal/w/${PERSONAL_WORKSPACE_ID}`;
const TEAM_BACKLOG = '/aoba/w/019a0000-0000-7000-8000-000000000401';

async function call<D extends AnyOperationDefinition>(
  request: APIRequestContext,
  operation: D,
  input: InputOf<D>,
): Promise<OutputOf<D>> {
  const response = await request.post(operationPath(operation, 'personal'), {
    headers: { Authorization: `Bearer ${SEED_API_TOKENS.personalWrite.token}` },
    data: operation.input.parse(input),
  });
  expect(response.status(), operation.name).toBe(200);
  return operation.output.parse(await response.json()) as OutputOf<D>;
}

test('自分用の組織では、依頼先の付いた行にチップが出て選び直せ、依頼先で絞り込める', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = `依頼先A-${suffix}`;
  const second = `依頼先B-${suffix}`;
  const delegated = `依頼した仕事-${suffix}`;
  const own = `手元の仕事-${suffix}`;
  const delegateeIds: string[] = [];
  const taskIds: string[] = [];
  try {
    const a = (await call(request, delegateeCreate, { name: first })).delegatee;
    delegateeIds.push(a.id);
    const b = (await call(request, delegateeCreate, { name: second })).delegatee;
    delegateeIds.push(b.id);
    const delegatedTask = (await call(request, taskCreate, { workspace_id: PERSONAL_WORKSPACE_ID, title: delegated }))
      .task;
    taskIds.push(delegatedTask.id);
    await call(request, taskDelegate, {
      workspace_id: PERSONAL_WORKSPACE_ID,
      task_id: delegatedTask.id,
      delegatee_id: a.id,
    });
    taskIds.push((await call(request, taskCreate, { workspace_id: PERSONAL_WORKSPACE_ID, title: own })).task.id);

    const collect = await watchViolations(page);
    await signIn(context, baseURL, 'personalAdmin');
    await page.goto(PERSONAL_BACKLOG);
    const delegatedRow = page.locator('.entry', { hasText: delegated });
    const ownRow = page.locator('.entry', { hasText: own });
    await expect(delegatedRow.getByRole('button', { name: `依頼先: ${first}` })).toBeVisible();
    // 依頼先の無い行にはチップを出さない
    await expect(ownRow.getByRole('button', { name: '担当: 未設定' })).toBeVisible();
    await expect(ownRow.getByRole('button', { name: /^依頼先/ })).toHaveCount(0);

    // チップを押すと名簿の人が並び、別の人を選ぶと保存して行に出る
    await delegatedRow.getByRole('button', { name: `依頼先: ${first}` }).click();
    const menu = page.getByRole('menu', { name: '依頼先を選ぶ' });
    await expect(menu.getByRole('menuitemradio', { name: '依頼先を外す' })).toBeVisible();
    const saved = waitForResponses(page, '/task-delegate');
    await menu.getByRole('menuitemradio', { name: second }).click();
    await saved;
    await expect(delegatedRow.getByRole('button', { name: `依頼先: ${second}` })).toBeVisible();
    // 引き出しが読む task-detail にも出る
    expect(
      (await call(request, taskDetail, { workspace_id: PERSONAL_WORKSPACE_ID, task_id: delegatedTask.id })).task
        .delegatee,
    ).toEqual(b);

    // 帯の「依頼先」で絞ると、その人の付いたタスクだけが出て、URL に残る
    const bar = page.getByRole('search', { name: 'バックログの絞り込み' });
    const select = bar.getByRole('combobox', { name: '依頼先', exact: true });
    await select.selectOption({ label: second });
    await expect(page).toHaveURL(new RegExp(`delegatee=${b.id}`));
    const titles = page.locator('.tree .entry-title');
    await expect(titles).toHaveText([delegated]);
    await page.reload();
    await expect(titles).toHaveText([delegated]);
    await expect(bar.getByRole('combobox', { name: '依頼先', exact: true })).toHaveValue(b.id);

    // 「依頼先なし」は、依頼先の付いていないタスクだけを出す
    await bar.getByRole('combobox', { name: '依頼先', exact: true }).selectOption({ label: '依頼先なし' });
    await expect(page).toHaveURL(/delegatee=none/);
    await expect(ownRow).toBeVisible();
    await expect(delegatedRow).toHaveCount(0);

    // 外すとチップが消え、フォーカスはその行のタイトルへ移る
    await bar.getByRole('button', { name: '絞り込みを外す' }).click();
    await expect(delegatedRow).toBeVisible();
    await delegatedRow.getByRole('button', { name: `依頼先: ${second}` }).click();
    const cleared = waitForResponses(page, '/task-delegate');
    await page.getByRole('menu', { name: '依頼先を選ぶ' }).getByRole('menuitemradio', { name: '依頼先を外す' }).click();
    await cleared;
    await expect(delegatedRow.getByRole('button', { name: /^依頼先/ })).toHaveCount(0);
    await expect(delegatedRow.getByRole('link', { name: delegated })).toBeFocused();
    expect(await collect()).toEqual([]);
  } finally {
    for (const id of taskIds) await call(request, taskDelete, { workspace_id: PERSONAL_WORKSPACE_ID, task_id: id });
    for (const id of delegateeIds) await call(request, delegateeDelete, { delegatee_id: id });
  }
});

test('チーム用の組織のバックログには、依頼先のチップも絞り込みも出さない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto(TEAM_BACKLOG);
  const bar = page.getByRole('search', { name: 'バックログの絞り込み' });
  await expect(bar.getByRole('combobox', { name: '担当', exact: true })).toBeVisible();
  await expect(bar.getByRole('combobox', { name: '依頼先', exact: true })).toHaveCount(0);
  await expect(page.locator('.tree .entry').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^依頼先/ })).toHaveCount(0);
});
