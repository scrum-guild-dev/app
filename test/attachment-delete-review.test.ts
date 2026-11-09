// #1083: 削除済みの D1 と R2 の後処理、タスクに残す履歴を公開 API から確かめる。
import { env } from 'cloudflare:workers';
import { expect, test, vi } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { attachmentDelete } from '../src/shared/operations/attachment/index.ts';
import { app, recordingBucket } from './attachment-helpers.ts';
import { storedFile } from './attachment-download-helpers.ts';
import { createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, type Person } from './operations/world.ts';

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

test('R2 の削除が失敗しても、確定した削除の成功と件数だけのログを返す', async () => {
  const { target, row, remove, attachment } = await fixture();
  const privateMessage = '秘密の本文を含む一時的なストレージの失敗';
  const bucket = recordingBucket({
    delete: async () => {
      throw new Error(privateMessage);
    },
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await remove(bucket.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: row.id });
    expect(await attachment()).toBeUndefined();
    // R2 の後処理が失敗したことは記録し、本文・キー・認証情報は出さない。
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(JSON.parse(logged)).toMatchObject({ count: 1 });
    for (const secret of [row.object_key, row.file_name, target.member.token, privateMessage]) {
      expect(logged).not.toContain(secret);
    }
    expect(await env.ATTACHMENTS.head(row.object_key)).not.toBeNull();
    expect(bucket.calls.filter((call) => call.method === 'delete')).toEqual([
      { method: 'delete', key: row.object_key },
    ]);
    expect((await remove()).status).toBe(404);
  } finally {
    error.mockRestore();
  }
});

test('削除権限のないメンバーでは R2 の後処理も呼ばない', async () => {
  const { target, row, remove, attachment } = await fixture();
  const other = await createPerson({
    organization: target.organization,
    membership: { workspaceId: target.workspace.id, role: 'member' },
  });
  const bucket = recordingBucket();
  expect((await remove(bucket.env, other)).status).toBe(403);
  expect(bucket.calls.filter((call) => call.method === 'delete')).toEqual([]);
  expect(await attachment()).toBeDefined();
  expect(await env.ATTACHMENTS.head(row.object_key)).not.toBeNull();
});
