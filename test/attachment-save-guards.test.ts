import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { taskUpdate } from '../src/shared/operations/task/index.ts';
import { app, attachmentRows } from './attachment-helpers.ts';
import { createAttachment, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

describe('添付を確定する文の境界', () => {
  test('全項目と20添付を書いても、各文の束縛は100個以下', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const files = await Promise.all(
      Array.from({ length: 20 }, () =>
        createAttachment(target.organization, target.workspace.id, target.member.userId!),
      ),
    );
    const counts: number[] = [];
    const bindings = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        for (const sql of sqls) {
          const count = (sql.match(/\?/g) ?? []).length;
          counts.push(count);
          expect(count).toBeLessThanOrEqual(100);
        }
      },
    });
    const response = await post(app, taskUpdate, {
      slug: target.slug,
      token: target.member.token,
      env: bindings,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        title: '添付を確認する',
        points: 3,
        due_on: '2026-11-10',
        link_url: 'https://example.com/',
        body_md: '本文',
        repository_id: null,
        category_id: null,
        attachment_ids: files.map((file) => file.id),
      },
    });
    expect(response.status).toBe(200);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(20);
  });

  test.each(['掃除', 'ほかの保存'] as const)('読み取り後の%sに負けたら本文を変えない', async (race) => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.member.userId!, {
      body_md: '保存前',
    });
    const other = await createTask(target.organization, target.workspace.id, target.member.userId!);
    const file = await createAttachment(target.organization, target.workspace.id, target.member.userId!);
    const db = orgDb(env, target.organization.verified);
    let raced = false;
    const bindings = envWithD1Hooks(env, {
      async afterQuery(sql) {
        if (raced || !sql.startsWith('select') || !sql.includes('from "attachments"')) return;
        raced = true;
        await db.batch([
          race === '掃除'
            ? db.statement((q) =>
                q.deleteFrom('attachments').where('workspace_id', '=', target.workspace.id).where('id', '=', file.id),
              )
            : db.statement((q) =>
                q
                  .updateTable('attachments')
                  .set({ task_id: other.id, attached_at: '2026-11-04T00:00:00.000Z' })
                  .where('workspace_id', '=', target.workspace.id)
                  .where('id', '=', file.id),
              ),
        ]);
      },
    });
    const response = await post(app, taskUpdate, {
      slug: target.slug,
      token: target.member.token,
      env: bindings,
      body: { workspace_id: target.workspace.id, task_id: task.id, body_md: '保存後', attachment_ids: [file.id] },
    });
    expect(raced).toBe(true);
    expect(response.status).toBe(race === '掃除' ? 404 : 409);
    const stored = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('body_md')
          .where('id', '=', task.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(stored?.body_md).toBe('保存前');
    const files = await attachmentRows(target);
    if (race === '掃除') expect(files).toEqual([]);
    else expect(files[0]?.task_id).toBe(other.id);
  });
});
