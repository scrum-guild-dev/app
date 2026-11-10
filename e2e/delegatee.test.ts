// 自分用の組織の依頼先を、本物の HTTP API と API トークンで読み書きする。
// 固定の seed のタスクは変えず、毎回作ったタスクと名簿だけを後始末する。
import type { APIRequestContext } from '@playwright/test';
import { SEED_API_TOKENS } from '../seed/api-tokens.ts';
import {
  operationPath,
  type AnyOperationDefinition,
  type InputOf,
  type OutputOf,
} from '../src/shared/operations/define.ts';
import {
  delegateeCreate,
  delegateeDelete,
  delegateeList,
  delegateeUpdate,
  organizationInfo,
} from '../src/shared/operations/organization/index.ts';
import { taskCreate, taskDelegate, taskDelete, taskDetail } from '../src/shared/operations/task/index.ts';
import { expect, test } from './fixtures.ts';

const WORKSPACE_ID = '019a0000-0000-7000-8000-000000000406';

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

test('名簿を手入れし、担当なしのタスクへ依頼先を付け外しできる', async ({ request }) => {
  const suffix = crypto.randomUUID();
  const name = `依頼先-${suffix}`;
  const renamed = `変更後-${suffix}`;
  let delegateeId: string | null = null;
  let taskId: string | null = null;
  try {
    const organization = await call(request, organizationInfo, {});
    expect(organization.organization.kind).toBe('personal');
    const created = await call(request, delegateeCreate, { name });
    delegateeId = created.delegatee.id;
    const updated = await call(request, delegateeUpdate, { delegatee_id: delegateeId, name: renamed });
    expect(updated.delegatee).toEqual({ id: delegateeId, name: renamed });
    expect((await call(request, delegateeList, {})).delegatees).toContainEqual(updated.delegatee);

    const createdTask = await call(request, taskCreate, {
      workspace_id: WORKSPACE_ID,
      title: `依頼の確認-${suffix}`,
    });
    taskId = createdTask.task.id;
    const taskInput = { workspace_id: WORKSPACE_ID, task_id: taskId };
    expect((await call(request, taskDetail, taskInput)).task.assignee).toBeNull();
    await call(request, taskDelegate, { ...taskInput, delegatee_id: delegateeId });
    const delegated = (await call(request, taskDetail, taskInput)).task;
    expect(delegated.delegatee).toEqual(updated.delegatee);
    expect(delegated.assignee).toMatchObject({ id: organization.me.id, name: organization.me.name });

    await call(request, taskDelegate, { ...taskInput, delegatee_id: null });
    const undelegated = (await call(request, taskDetail, taskInput)).task;
    expect(undelegated.delegatee).toBeNull();
    expect(undelegated.assignee).toEqual(delegated.assignee);

    await call(request, delegateeDelete, { delegatee_id: delegateeId });
    expect((await call(request, delegateeList, {})).delegatees.some((row) => row.id === delegateeId)).toBe(false);
    delegateeId = null;
  } finally {
    if (taskId !== null) await call(request, taskDelete, { workspace_id: WORKSPACE_ID, task_id: taskId });
    if (delegateeId !== null) await call(request, delegateeDelete, { delegatee_id: delegateeId });
  }
});
