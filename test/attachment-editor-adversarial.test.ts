import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { commentUpdate, taskFieldSet, taskUpdate } from '../src/shared/operations/task/index.ts';
import { app, attachmentRows, recordingBucket } from './attachment-helpers.ts';
import { download, storedFile } from './attachment-download-helpers.ts';
import { createComment, createDetailField, createTask, createTaskFieldValue } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

describe('添付保存の反証', () => {
  test('同じ未添付を別々のタスクへ同時に保存しても勝者だけが本文と添付を書く', async () => {
    const target = await createTarget();
    const tasks = await Promise.all(
      [0, 1].map(() => createTask(target.organization, target.workspace.id, target.member.userId!, { body_md: '元' })),
    );
    const { row } = await storedFile(target);
    const responses = await Promise.all(
      tasks.map((task, i) =>
        post(app, taskUpdate, {
          slug: target.slug,
          token: target.member.token,
          body: { workspace_id: target.workspace.id, task_id: task.id, body_md: `勝者${i}`, attachment_ids: [row.id] },
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const db = orgDb(env, target.organization.verified);
    const stored = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select(['id', 'body_md'])
          .where('workspace_id', '=', target.workspace.id)
          .where(
            'id',
            'in',
            tasks.map((t) => t.id),
          ),
      ),
    );
    const attached = (await attachmentRows(target)).find((a) => a.id === row.id)!;
    for (const task of stored)
      expect(task.body_md).toBe(
        task.id === attached.task_id ? `勝者${tasks.findIndex((t) => t.id === task.id)}` : '元',
      );
  });

  test('値の行が無いまま画像以外だけを保存でき、未記入の欄を作らない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const field = await createDetailField(target.organization, target.workspace.id);
    const { row } = await storedFile(target, { contentType: 'application/octet-stream' });
    const response = await post(app, taskFieldSet, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        field_id: field.id,
        read_md: null,
        value_md: null,
        attachment_ids: [row.id],
      },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { field: { value_md: string | null } }).field.value_md).toBeNull();
    expect((await attachmentRows(target)).find((a) => a.id === row.id)?.task_id).toBe(task.id);
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.first(
        db.statement((q) =>
          q
            .selectFrom('task_field_values')
            .select('field_id')
            .where('task_id', '=', task.id)
            .where('field_id', '=', field.id),
        ),
      ),
    ).toBeUndefined();
  });

  test('古い欄の値で保存しても添付は未確定のまま残る', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const field = await createDetailField(target.organization, target.workspace.id);
    await createTaskFieldValue(target.organization, task.id, field.id, target.member.userId!, {
      value_md: '別の画面で保存済み',
    });
    const { row } = await storedFile(target);
    const response = await post(app, taskFieldSet, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        field_id: field.id,
        read_md: '古い値',
        value_md: '上書きしない',
        attachment_ids: [row.id],
      },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'changed',
    );
    expect((await attachmentRows(target)).find((a) => a.id === row.id)?.attached_at).toBeNull();
  });

  test('リーダーでも他人のコメントへの添付を使って本文を書き換えられない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const comment = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    const { row } = await storedFile(target, { person: target.leader });
    const response = await post(app, commentUpdate, {
      slug: target.slug,
      token: target.leader.token,
      body: {
        workspace_id: target.workspace.id,
        comment_id: comment.id,
        body_md: '乗っ取らない',
        attachment_ids: [row.id],
      },
    });
    expect(response.status).toBe(403);
    expect((await attachmentRows(target)).find((a) => a.id === row.id)?.attached_at).toBeNull();
  });

  test.each(['task', 'comment', 'parent'] as const)('削除した%sの添付は管理者にもR2を読まず404', async (kind) => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const comment = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    const { row } = await storedFile(target, {
      row: {
        ...(kind === 'task' ? { task_id: task.id } : { comment_id: comment.id }),
        attached_at: '2026-11-04T00:00:00.000Z',
      },
    });
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      kind === 'comment'
        ? db.statement((q) =>
            q
              .updateTable('comments')
              .set({ deleted_at: '2026-11-04T00:00:00.000Z', deleted_by: target.admin.userId!, body_md: '' })
              .where('workspace_id', '=', target.workspace.id)
              .where('id', '=', comment.id),
          )
        : db.statement((q) =>
            q
              .updateTable('tasks')
              .set({ deleted_at: '2026-11-04T00:00:00.000Z' })
              .where('workspace_id', '=', target.workspace.id)
              .where('id', '=', task.id),
          ),
    ]);
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, row.id, { person: target.admin, env: bindings });
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
