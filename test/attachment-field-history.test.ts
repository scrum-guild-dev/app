import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { taskFieldSet, taskHistory } from '../src/shared/operations/task/index.ts';
import { app } from './attachment-helpers.ts';
import { createAttachment, createDetailField, createTask, createTaskFieldValue } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

test.each([null, '今の値'])('欄の値を変えず添付した履歴は添付だけを記録する（値=%s）', async (value) => {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
  const field = await createDetailField(target.organization, target.workspace.id);
  if (value !== null)
    await createTaskFieldValue(target.organization, task.id, field.id, target.member.userId!, { value_md: value });
  const file = await createAttachment(target.organization, target.workspace.id, target.member.userId!);
  const response = await post(app, taskFieldSet, {
    slug: target.slug,
    token: target.member.token,
    body: {
      workspace_id: target.workspace.id,
      task_id: task.id,
      field_id: field.id,
      read_md: value,
      value_md: value,
      attachment_ids: [file.id],
    },
  });
  expect(response.status).toBe(200);
  const db = orgDb(env, target.organization.verified);
  const logs = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select('changes_json')
        .where('workspace_id', '=', target.workspace.id)
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', task.id),
    ),
  );
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]!.changes_json)).toEqual({ attachments: [null, [{ id: file.id }]] });
  const history = await post(app, taskHistory, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, task_id: task.id },
  });
  expect(history.status).toBe(200);
  const body = (await history.json()) as { entries: { changes: unknown[] }[] };
  expect(body.entries[0]?.changes).toEqual([{ field: 'attachments', before: null, after: null }]);
});
