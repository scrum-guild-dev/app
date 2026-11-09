// #739: 一覧と削除を公開 API から確かめる。R2 は Workers の実体を使う。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { attachmentDelete, attachmentList } from '../src/shared/operations/attachment/index.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { orgDb } from '../src/server/db/index.ts';
import { app } from './attachment-helpers.ts';
import { download, storedFile } from './attachment-download-helpers.ts';
import { createComment, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const ATTACHED_AT = '2026-11-03T00:00:00.000Z';

function list(target: Target, taskId: string, person: Person = target.member, workspaceId = target.workspace.id) {
  return post(app, attachmentList, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: workspaceId, task_id: taskId },
  });
}

function remove(target: Target, taskId: string, attachmentId: string, person: Person = target.member) {
  return post(app, attachmentDelete, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, attachment_id: attachmentId },
  });
}

async function attached(target: Target, options: Parameters<typeof storedFile>[1] = {}) {
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
  const file = await storedFile(target, {
    ...options,
    row: { task_id: task.id, attached_at: ATTACHED_AT, ...options.row },
  });
  return { task, ...file };
}

async function attachmentRow(target: Target, id: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('attachments').selectAll().where('id', '=', id).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

describe('タスクの添付一覧', () => {
  test('画像、動画、それ以外と本文に差し込んだ画像を名前・容量・上げた人・上げた日時付きで返す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const files: Awaited<ReturnType<typeof storedFile>>['row'][] = [];
    for (const [contentType, fileName] of [
      ['image/png', '本文の画面.png'],
      ['video/mp4', '手順.mp4'],
      ['application/pdf', '説明.pdf'],
    ]) {
      const { row } = await storedFile(target, {
        contentType,
        fileName,
        row: { task_id: task.id, attached_at: ATTACHED_AT, created_at: '2026-11-01T01:02:03.000Z' },
      });
      files.push(row);
    }
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ body_md: `![本文の画面](/api/${target.slug}/attachments/${files[0]!.id})` })
          .where('id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    ]);
    const response = await list(target, task.id);
    expect(response.status).toBe(200);
    const output = (await response.json()) as OutputOf<typeof attachmentList>;
    expect(output.attachments).toHaveLength(3);
    for (const file of files) {
      expect(output.attachments.find((row) => row.id === file.id)).toMatchObject({
        id: file.id,
        file_name: file.file_name,
        content_type: file.content_type,
        size_bytes: file.size_bytes,
        created_at: '2026-11-01T01:02:03.000Z',
        uploaded_by: target.member.userId,
        uploaded_by_name: expect.any(String),
        deletable: true,
      });
    }
  });

  test('添付がなければ空の一覧を返す', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const response = await list(target, task.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachments: [] });
  });

  test('別タスク、コメント、まだ付いていないファイルを混ぜない', async () => {
    const target = await createTarget();
    const own = await attached(target);
    await attached(target);
    await storedFile(target);
    const comment = await createComment(target.organization, target.workspace.id, own.task.id, target.member.userId!);
    await storedFile(target, { row: { comment_id: comment.id, attached_at: ATTACHED_AT } });
    const response = await list(target, own.task.id);
    expect(response.status).toBe(200);
    const output = (await response.json()) as OutputOf<typeof attachmentList>;
    expect(output.attachments.map((row) => row.id)).toEqual([own.row.id]);
  });

  test('ほかのメンバーには削除不可、リーダーと所属していない管理者には削除可を返す', async () => {
    const target = await createTarget();
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const { task } = await attached(target);
    for (const [person, deletable] of [
      [other, false],
      [target.leader, true],
      [target.admin, true],
    ] as const) {
      const response = await list(target, task.id, person);
      expect(response.status).toBe(200);
      const output = (await response.json()) as OutputOf<typeof attachmentList>;
      expect(output.attachments[0]?.deletable).toBe(deletable);
    }
  });

  test('閉じたワークスペースは読めるが削除不可を返す', async () => {
    const target = await createTarget({ closed: true });
    const { task } = await attached(target);
    const response = await list(target, task.id);
    expect(response.status).toBe(200);
    const output = (await response.json()) as OutputOf<typeof attachmentList>;
    expect(output.attachments[0]?.deletable).toBe(false);
  });

  test('同じ組織の別ワークスペースのタスクと存在しないタスクは 404', async () => {
    const target = await createTarget();
    const other = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    for (const id of [other.id, crypto.randomUUID()]) {
      const response = await list(target, id);
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('not_found');
    }
  });

  test('削除済みタスクは一覧を読めない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: ATTACHED_AT,
    });
    const response = await list(target, task.id);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
  });
});

describe('タスクの添付削除', () => {
  test.each(['member', 'leader', 'admin'] as const)('%s は上げた本人かリーダー・管理者として消せる', async (role) => {
    const target = await createTarget();
    const { task, row } = await attached(target);
    const response = await remove(target, task.id, row.id, target[role]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: row.id });
    expect(await attachmentRow(target, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.head(row.object_key)).toBeNull();
    expect((await download(target, row.id)).status).toBe(404);
    const listed = await list(target, task.id);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ attachments: [] });
  });

  test('ほかのメンバーは消せず、行と R2 が残る', async () => {
    const target = await createTarget();
    const other = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const { task, row } = await attached(target);
    const response = await remove(target, task.id, row.id, other);
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('forbidden');
    expect(await attachmentRow(target, row.id)).toBeDefined();
    expect(await env.ATTACHMENTS.head(row.object_key)).not.toBeNull();
  });

  test('閉じたワークスペースは消せず、行と R2 が残る', async () => {
    const target = await createTarget({ closed: true });
    const { task, row } = await attached(target);
    const response = await remove(target, task.id, row.id);
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('workspace_closed');
    expect(await attachmentRow(target, row.id)).toBeDefined();
    expect(await env.ATTACHMENTS.head(row.object_key)).not.toBeNull();
  });

  test('本文から画像を消さず、削除済みの URL は 404 になる', async () => {
    const target = await createTarget();
    const { task, row } = await attached(target);
    const body = `![画面](/api/${target.slug}/attachments/${row.id})`;
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ body_md: body })
          .where('id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    ]);
    expect((await remove(target, task.id, row.id)).status).toBe(200);
    const current = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('body_md')
          .where('id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(current?.body_md).toBe(body);
    expect((await download(target, row.id)).status).toBe(404);
  });

  test('別タスクや未添付のファイルを ID だけで消せない', async () => {
    const target = await createTarget();
    const own = await attached(target);
    const other = await attached(target);
    const unattached = await storedFile(target);
    for (const row of [other.row, unattached.row]) {
      const response = await remove(target, own.task.id, row.id, target.admin);
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('not_found');
      expect(await attachmentRow(target, row.id)).toBeDefined();
      expect(await env.ATTACHMENTS.head(row.object_key)).not.toBeNull();
    }
  });

  test('別組織のファイルを自分のタスクに指定しても消せない', async () => {
    const own = await createTarget();
    const other = await createTarget();
    const task = await createTask(own.organization, own.workspace.id, own.member.userId!);
    const foreign = await attached(other);
    const response = await remove(own, task.id, foreign.row.id, own.admin);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expect(await attachmentRow(other, foreign.row.id)).toBeDefined();
    expect(await env.ATTACHMENTS.head(foreign.row.object_key)).not.toBeNull();
  });

  test('削除済みのタスクのファイルは消せない', async () => {
    const target = await createTarget();
    const { task, row } = await attached(target);
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('tasks')
          .set({ deleted_at: ATTACHED_AT })
          .where('id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    ]);
    const response = await remove(target, task.id, row.id, target.admin);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expect(await attachmentRow(target, row.id)).toBeDefined();
    expect(await env.ATTACHMENTS.head(row.object_key)).not.toBeNull();
  });
});
