// #738: 同じ値の保存でも、添付の成否を再送時に取り違えない。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { taskFieldSet } from '../src/shared/operations/task/index.ts';
import { app } from './attachment-helpers.ts';
import { createAttachment, createDetailField, createTask, createTaskFieldValue, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

async function fixture(value: string | null) {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
  const field = await createDetailField(target.organization, target.workspace.id);
  if (value !== null)
    await createTaskFieldValue(target.organization, task.id, field.id, target.member.userId!, { value_md: value });
  const db = orgDb(env, target.organization.verified);
  const save = (attachmentId: string) =>
    post(app, taskFieldSet, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        field_id: field.id,
        read_md: value,
        value_md: value,
        attachment_ids: [attachmentId],
      },
    });
  const snapshot = async () => {
    const [fields, logs, taskRow] = await Promise.all([
      db.rows(
        db.statement((q) =>
          q.selectFrom('task_field_values').selectAll().where('task_id', '=', task.id).where('field_id', '=', field.id),
        ),
      ),
      db.rows(
        db.statement((q) =>
          q
            .selectFrom('change_logs')
            .selectAll()
            .where('workspace_id', '=', target.workspace.id)
            .where('entity_type', '=', 'task')
            .where('entity_id', '=', task.id)
            .orderBy('id'),
        ),
      ),
      db.first(
        db.statement((q) =>
          q.selectFrom('tasks').selectAll().where('workspace_id', '=', target.workspace.id).where('id', '=', task.id),
        ),
      ),
    ]);
    return { fields, logs, task: taskRow };
  };
  const newFile = () => createAttachment(target.organization, target.workspace.id, target.member.userId!);
  return { target, task, field, db, save, snapshot, newFile };
}

describe.each([null, '変えない条件'])('決まった欄の同じ値を保存する（値=%s）', (value) => {
  test('新しい添付は成功し、欄の内容を保ち、添付だけの履歴を残す', async () => {
    const context = await fixture(value);
    const file = await context.newFile();
    expect((await context.save(file.id)).status).toBe(200);
    const stored = await context.snapshot();
    expect(stored.fields.map((row) => row.value_md)).toEqual(value === null ? [] : [value]);
    expect(stored.logs).toHaveLength(1);
    expect(JSON.parse(stored.logs[0]!.changes_json)).toEqual({ attachments: [null, [{ id: file.id }]] });
    expect(
      await context.db.first(
        context.db.statement((q) =>
          q
            .selectFrom('attachments')
            .select(['task_id', 'attached_at'])
            .where('workspace_id', '=', context.target.workspace.id)
            .where('id', '=', file.id),
        ),
      ),
    ).toMatchObject({ task_id: context.task.id, attached_at: expect.any(String) });
  });

  test.each(['同じIDを再送', '無いID', '削除されたID'] as const)(
    '%sは成功扱いせず、内容と履歴も変えない',
    async (kind) => {
      const context = await fixture(value);
      const file = await context.newFile();
      expect((await context.save(file.id)).status).toBe(200);
      let id = file.id;
      if (kind === '無いID') id = uuidv7();
      if (kind === '削除されたID') {
        const deleted = await context.newFile();
        id = deleted.id;
        await context.db.run(
          context.db.statement((q) =>
            q.deleteFrom('attachments').where('workspace_id', '=', context.target.workspace.id).where('id', '=', id),
          ),
        );
      }
      const before = await context.snapshot();
      const response = await context.save(id);
      expect(response.status).toBe(kind === '同じIDを再送' ? 409 : 404);
      const body = (await response.json()) as {
        error: { code: string; details: { reason?: string; attachment_ids: string[] } };
      };
      expect(body.error.code).toBe(kind === '同じIDを再送' ? 'conflict' : 'not_found');
      expect(body.error.details.attachment_ids).toEqual([id]);
      if (kind === '同じIDを再送') expect(body.error.details.reason).toBe('attachment_attached');
      expect(await context.snapshot()).toEqual(before);
    },
  );
});
