import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { queryPlanForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { backlogCountsStatement } from '../src/server/operations/task.ts';
import { backlogTree } from '../src/shared/operations/task/index.ts';
import {
  createBoardColumn,
  createDetailField,
  createSprint,
  createStory,
  createTask,
  createWorkspace,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
async function counts(target: Target, query?: string) {
  const response = await post(app, backlogTree, {
    slug: target.slug,
    token: target.member.token,
    body: { workspace_id: target.workspace.id, query },
  });
  expect(response.status).toBe(200);
  return backlogTree.output.parse(await response.json());
}

describe('バックログの見出しの集計', () => {
  test('空のワークスペースは4つとも0', async () => {
    expect(await counts(await createTarget())).toMatchObject({
      open_count: 0,
      unfilled_count: 0,
      unestimated_count: 0,
      unscheduled_count: 0,
    });
  });

  test('未完了のバックログ全体を数える。親と絞り込みに左右されず、0ポイントは見積もり済み', async () => {
    const target = await createTarget();
    const { organization, workspace, member } = target;
    await createDetailField(organization, workspace.id);
    const story = await createStory(organization, workspace.id, member.userId!);
    const sprint = await createSprint(organization, workspace.id);
    const column = await createBoardColumn(organization, workspace.id);
    await createTask(organization, workspace.id, member.userId!, { title: '検索に当たる' });
    await createTask(organization, workspace.id, member.userId!, { story_id: story.id, points: 0 });
    await createTask(organization, workspace.id, member.userId!, {
      points: 5,
      sprint_id: sprint.id,
      column_id: column.id,
      column_position: 'a0',
    });
    await createTask(organization, workspace.id, member.userId!, {
      completed_at: '2026-11-01T00:00:00.000Z',
      completed_by: member.userId,
    });
    await createTask(organization, workspace.id, member.userId!, { deleted_at: '2026-11-01T00:00:00.000Z' });
    await createTask(organization, workspace.id, member.userId!, { tray: 'inbox', is_imported: 1 });
    const expected = { open_count: 3, unfilled_count: 3, unestimated_count: 1, unscheduled_count: 2 };
    expect(await counts(target)).toMatchObject(expected);
    expect(await counts(target, '検索に当たる')).toMatchObject(expected);
    expect(await counts(target, '存在しない題')).toMatchObject(expected);
  });

  test('別のワークスペースと別の組織のタスクを数えない', async () => {
    const target = await createTarget();
    const elsewhere = await createTarget();
    const otherWorkspace = await createWorkspace(target.organization, target.admin.userId!);
    await createTask(target.organization, otherWorkspace.id, target.admin.userId!);
    await createTask(elsewhere.organization, elsewhere.workspace.id, elsewhere.member.userId!);
    expect(await counts(target)).toMatchObject({ open_count: 0, unestimated_count: 0, unscheduled_count: 0 });
  });

  test('スプリントが削除されていれば、入っていないものとして数える', async () => {
    const target = await createTarget();
    const sprint = await createSprint(target.organization, target.workspace.id, {
      deleted_at: '2026-11-01T00:00:00.000Z',
    });
    const column = await createBoardColumn(target.organization, target.workspace.id);
    await createTask(target.organization, target.workspace.id, target.member.userId!, {
      sprint_id: sprint.id,
      column_id: column.id,
      column_position: 'a0',
    });
    expect(await counts(target)).toMatchObject({ open_count: 1, unscheduled_count: 1 });
  });

  test('ワークスペースと受け皿の索引を使う', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const plan = (await queryPlanForTest(env, backlogCountsStatement(db, target.workspace.id))).join('\n');
    expect(plan).toContain('tasks_workspace_tray');
    expect(plan).not.toMatch(/SCAN tasks\b/);
  });
});
