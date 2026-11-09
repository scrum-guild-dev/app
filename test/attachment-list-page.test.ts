import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { ATTACHMENT_LIST_PAGE_SIZE, attachmentList } from '../src/shared/operations/attachment/index.ts';
import { orgDb } from '../src/server/db/index.ts';
import { createApp } from '../src/server/app.ts';
import { attachmentListOperation } from '../src/server/operations/attachment-list-page.ts';
import { createAttachment, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

const app = createApp([attachmentListOperation]);
const AT = '2026-11-01T00:00:00.000Z';
type Cursor = { created_at: string; id: string };

async function fixture(count: number, variedTime = false) {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!);
  const files: Awaited<ReturnType<typeof createAttachment>>[] = [];
  for (let index = 0; index < count; index++) {
    files.push(
      await createAttachment(target.organization, target.workspace.id, target.member.userId!, {
        task_id: task.id,
        attached_at: AT,
        file_name: `資料${index}.txt`,
        created_at: variedTime && index % 2 === 0 ? '2026-11-02T00:00:00.000Z' : AT,
      }),
    );
  }
  const read = async (after?: Cursor, taskId = task.id) => {
    const response = await post(app, attachmentList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, task_id: taskId, ...(after === undefined ? {} : { after }) },
    });
    expect(response.status).toBe(200);
    return attachmentList.output.parse(await response.json());
  };
  return { target, task, files, read };
}

test('0件なら空の一覧で、続きのカーソルは返さない', async () => {
  const { read } = await fixture(0);
  expect(await read()).toEqual({ attachments: [] });
});

test('50件ちょうどなら全件を返し、続きのカーソルは返さない', async () => {
  const { read } = await fixture(ATTACHMENT_LIST_PAGE_SIZE);
  const page = await read();
  expect(page.attachments).toHaveLength(50);
  expect(page).not.toHaveProperty('next_cursor');
});

test('同じ日時の51件をID順で50件と1件に分け、重複も欠落もない', async () => {
  const { files, read } = await fixture(51);
  const first = await read();
  expect(first.attachments).toHaveLength(50);
  expect(first.next_cursor).toEqual({ created_at: AT, id: first.attachments[49]!.id });
  const second = await read(first.next_cursor);
  expect(second.attachments).toHaveLength(1);
  expect(second).not.toHaveProperty('next_cursor');
  expect([...first.attachments, ...second.attachments].map((file) => file.id)).toEqual(
    files.map((file) => file.id).sort(),
  );
});

test('日時とIDで101件を3ページに分け、ほかのタスクと未添付を混ぜない', async () => {
  const { target, task, files, read } = await fixture(101, true);
  const otherTask = await createTask(target.organization, target.workspace.id, target.member.userId!);
  await createAttachment(target.organization, target.workspace.id, target.member.userId!, {
    task_id: otherTask.id,
    attached_at: AT,
  });
  await createAttachment(target.organization, target.workspace.id, target.member.userId!);
  const first = await read();
  const second = await read(first.next_cursor);
  const third = await read(second.next_cursor);
  expect([first.attachments.length, second.attachments.length, third.attachments.length]).toEqual([50, 50, 1]);
  const ordered = [...files].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  expect([...first.attachments, ...second.attachments, ...third.attachments].map((file) => file.id)).toEqual(
    ordered.map((file) => file.id),
  );
  expect(third).not.toHaveProperty('next_cursor');
  const own = await read(undefined, task.id);
  expect(own.attachments.every((file) => file.deletable)).toBe(true);
});

test('カーソルの行が削除されても、その日時とIDの後から読み続ける', async () => {
  const { target, read } = await fixture(51);
  const first = await read();
  const cursor = first.next_cursor!;
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q.deleteFrom('attachments').where('workspace_id', '=', target.workspace.id).where('id', '=', cursor.id),
    ),
  ]);
  const second = await read(cursor);
  expect(second.attachments).toHaveLength(1);
  expect(second.attachments[0]!.id > cursor.id).toBe(true);
  expect(second).not.toHaveProperty('next_cursor');
});

test('存在しない任意のカーソルも、その境界の後にある同じタスクだけを返す', async () => {
  const { read, files } = await fixture(2);
  const page = await read({ created_at: '2000-01-01T00:00:00.000Z', id: '存在しないID' });
  expect(page.attachments.map((file) => file.id)).toEqual(files.map((file) => file.id).sort());
  expect(await read({ created_at: '2100-01-01T00:00:00.000Z', id: '存在しないID' })).toEqual({ attachments: [] });
});
