// #1083: 削除済みの D1 と R2 の後処理、タスクに残す履歴を公開 API から確かめる。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { attachmentDelete } from '../src/shared/operations/attachment/index.ts';
import { taskHistory } from '../src/shared/operations/task/index.ts';
import { app } from './attachment-helpers.ts';
import { storedFile } from './attachment-download-helpers.ts';
import { createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person } from './operations/world.ts';

async function fixture() {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
  const { row } = await storedFile(target, {
    fileName: '非公開の相談.png',
    row: { task_id: task.id, attached_at: '2026-11-03T00:00:00.000Z' },
  });
  const remove = (bindings?: Env, person: Person = target.member) =>
    post(app, attachmentDelete, {
      slug: target.slug,
      token: person.token,
      env: bindings,
      body: { workspace_id: target.workspace.id, task_id: task.id, attachment_id: row.id },
    });
  const db = orgDb(env, target.organization.verified);
  const attachment = () =>
    db.first(
      db.statement((q) =>
        q
          .selectFrom('attachments')
          .selectAll()
          .where('workspace_id', '=', target.workspace.id)
          .where('id', '=', row.id),
      ),
    );
  return { target, task, row, remove, db, attachment };
}

test('添付削除をタスクの履歴へ1回だけ記録し、公開の履歴でも見られる', async () => {
  const { target, task, row, remove, db } = await fixture();
  expect((await remove()).status).toBe(200);
  expect((await remove()).status).toBe(404);
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
  const response = await post(app, taskHistory, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, task_id: task.id },
  });
  expect(response.status).toBe(200);
  const output = taskHistory.output.parse(await response.json());
  expect(output.entries).toHaveLength(1);
  expect(output.entries[0]).toMatchObject({
    action: 'update',
    changes: [{ field: 'attachments', before: 1, after: null }],
  });
});
