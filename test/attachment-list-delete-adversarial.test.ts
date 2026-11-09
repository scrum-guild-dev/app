// #739: 保存したキーの破損、上げた人の削除、R2 の欠損と再送を API から確かめる。
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { attachmentDelete } from '../src/shared/operations/attachment/index.ts';
import { orgDb } from '../src/server/db/index.ts';
import { app } from './attachment-helpers.ts';
import { storedFile } from './attachment-download-helpers.ts';
import { createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

async function fixture(overrides: Parameters<typeof storedFile>[1] = {}) {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
  const file = await storedFile(target, {
    ...overrides,
    row: { task_id: task.id, attached_at: '2026-11-01T00:00:00.000Z', ...overrides.row },
  });
  return { target, task, ...file };
}
function remove(target: Target, taskId: string, fileId: string, actor: Person = target.member) {
  return post(app, attachmentDelete, {
    slug: target.slug,
    token: actor.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, attachment_id: fileId },
  });
}
async function rowExists(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('attachments').select('id').where('workspace_id', '=', target.workspace.id).where('id', '=', id),
    ),
  );
}

test('行に別組織のキーが入っていても D1 と R2 を消さない', async () => {
  const foreign = await fixture();
  const { target, task, row } = await fixture({ row: { object_key: `${foreign.row.object_key}-orphan` } });
  const result = await remove(target, task.id, row.id, target.admin);
  expect(result.status).toBe(404);
  expect(await rowExists(target, row.id)).toBeDefined();
  expect(await rowExists(foreign.target, foreign.row.id)).toBeDefined();
  expect(await env.ATTACHMENTS.head(foreign.row.object_key)).not.toBeNull();
});

test('キーが同じ組織でも別の添付のキーなら消さない', async () => {
  const { target, task, row } = await fixture();
  const other = await storedFile(target, { row: { task_id: task.id, attached_at: '2026-11-01T00:00:00.000Z' } });
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('attachments')
        .set({ object_key: `${other.row.object_key}-orphan` })
        .where('workspace_id', '=', target.workspace.id)
        .where('id', '=', row.id),
    ),
  ]);
  expect((await remove(target, task.id, row.id)).status).toBe(404);
  expect(await rowExists(target, row.id)).toBeDefined();
  expect(await env.ATTACHMENTS.head(other.row.object_key)).not.toBeNull();
});

test('既に R2 から消えたファイルも行を片付けられる', async () => {
  const { target, task, row } = await fixture();
  await env.ATTACHMENTS.delete(row.object_key);
  expect((await remove(target, task.id, row.id)).status).toBe(200);
  expect(await rowExists(target, row.id)).toBeUndefined();
});

test('削除の再送は不存在の 404 で、別のファイルは残る', async () => {
  const { target, task, row } = await fixture();
  const other = await storedFile(target, { row: { task_id: task.id, attached_at: '2026-11-01T00:00:00.000Z' } });
  expect((await remove(target, task.id, row.id)).status).toBe(200);
  expect((await remove(target, task.id, row.id)).status).toBe(404);
  expect(await rowExists(target, other.row.id)).toBeDefined();
  expect(await env.ATTACHMENTS.head(other.row.object_key)).not.toBeNull();
});
