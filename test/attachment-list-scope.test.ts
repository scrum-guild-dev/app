import { expect, test } from 'vitest';
import { attachmentList } from '../src/shared/operations/attachment/index.ts';
import { app } from './attachment-helpers.ts';
import { createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

test('自分のワークスペースを指定しても別組織の task_id の一覧は読めない', async () => {
  const own = await createTarget();
  const foreign = await createTarget();
  const task = await createTask(foreign.organization, foreign.workspace.id, foreign.member.userId!);
  const response = await post(app, attachmentList, {
    slug: own.slug,
    token: own.member.token,
    body: {
      workspace_id: own.workspace.id,
      task_id: task.id,
    },
  });
  expect(response.status).toBe(404);
  expect(await errorCodeOf(response)).toBe('not_found');
});
