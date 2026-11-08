import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { taskDetail } from '../src/shared/operations/task/task-detail.ts';
import { createBoardColumn, createEpic, createSprint, createStory, createTask } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

const app = createApp(implementedOperations);

test('引き出しは列、ストーリー、エピックと持ち越しの印を返す', async () => {
  const t = await createTarget();
  const epic = await createEpic(t.organization, t.workspace.id, t.member.userId!);
  const story = await createStory(t.organization, t.workspace.id, t.member.userId!, { epic_id: epic.id });
  const sprint = await createSprint(t.organization, t.workspace.id);
  const column = await createBoardColumn(t.organization, t.workspace.id);
  const task = await createTask(t.organization, t.workspace.id, t.member.userId!, {
    story_id: story.id,
    sprint_id: sprint.id,
    column_id: column.id,
    today_on: '2026-10-01',
  });
  const response = await post(app, taskDetail, {
    slug: t.slug,
    token: t.member.token,
    body: { workspace_id: t.workspace.id, task_id: task.id },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    column: { id: column.id, name: column.name, is_done: false },
    story: { id: story.id, title: story.title },
    epic: { id: epic.id, title: epic.title },
    today_on: '2026-10-01',
  });
});

test('親なしとスプリントなしの列は null', async () => {
  const t = await createTarget();
  const task = await createTask(t.organization, t.workspace.id, t.member.userId!);
  const response = await post(app, taskDetail, {
    slug: t.slug,
    token: t.member.token,
    body: { workspace_id: t.workspace.id, task_id: task.id },
  });
  expect(await response.json()).toMatchObject({ column: null, story: null, epic: null, today_on: null });
});

test('別の組織の親と列を参照しても返さない', async () => {
  const t = await createTarget();
  const foreign = await createTarget();
  const story = await createStory(foreign.organization, foreign.workspace.id, foreign.member.userId!);
  const column = await createBoardColumn(foreign.organization, foreign.workspace.id);
  const sprint = await createSprint(t.organization, t.workspace.id);
  const task = await createTask(t.organization, t.workspace.id, t.member.userId!, {
    story_id: story.id,
    sprint_id: sprint.id,
    column_id: column.id,
  });
  const response = await post(app, taskDetail, {
    slug: t.slug,
    token: t.member.token,
    body: { workspace_id: t.workspace.id, task_id: task.id },
  });
  expect(await response.json()).toMatchObject({ column: null, story: null, epic: null });
});

test('削除した列は先頭へ、完了したタスクは名前の無い完了列へ表示する', async () => {
  const t = await createTarget();
  const sprint = await createSprint(t.organization, t.workspace.id);
  const deleted = await createBoardColumn(t.organization, t.workspace.id, {
    name: '削除済み',
    deleted_at: '2026-10-01T00:00:00Z',
  });
  const first = await createBoardColumn(t.organization, t.workspace.id, { name: '出発前', position: 'a0' });
  await createBoardColumn(t.organization, t.workspace.id, { name: '作業中', position: 'a1' });
  const done = await createBoardColumn(t.organization, t.workspace.id, { name: null, is_done: 1 });
  for (const completed_at of [null, '2026-10-01T00:00:00Z']) {
    const task = await createTask(t.organization, t.workspace.id, t.member.userId!, {
      sprint_id: sprint.id,
      column_id: deleted.id,
      completed_at,
    });
    const response = await post(app, taskDetail, {
      slug: t.slug,
      token: t.member.token,
      body: { workspace_id: t.workspace.id, task_id: task.id },
    });
    expect(await response.json()).toMatchObject({
      column:
        completed_at === null
          ? { id: first.id, name: '出発前', is_done: false }
          : { id: done.id, name: null, is_done: true },
    });
  }
});
