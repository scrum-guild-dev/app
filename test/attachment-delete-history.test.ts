import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { attachmentDelete } from '../src/shared/operations/attachment/index.ts';
import { app } from './attachment-helpers.ts';
import { storedFile } from './attachment-download-helpers.ts';
import { createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

test('添付削除は履歴を1件残し、再度の削除では増やさない', async () => {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
  const { row } = await storedFile(target, { row: { task_id: task.id, attached_at: '2026-11-03T00:00:00.000Z' } });
  const remove = () =>
    post(app, attachmentDelete, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        attachment_id: row.id,
      },
    });
  expect((await remove()).status).toBe(200);
  expect((await remove()).status).toBe(404);
  const db = orgDb(env, target.organization.verified);
  const logs = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', target.organization.id)
        .where('workspace_id', '=', target.workspace.id)
        .where('entity_type', '=', 'task')
        .where('entity_id', '=', task.id),
    ),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ actor_user_id: target.member.userId, action: 'update' });
  expect(JSON.parse(logs[0]!.changes_json!)).toEqual({ attachments: [[{ id: row.id }], null] });
});
