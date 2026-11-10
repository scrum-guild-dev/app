import { now } from '../../shared/clock.ts';
import { taskDelegate } from '../../shared/operations/task/index.ts';
import { ApiError } from '../errors.ts';
import { assertPersonalOrganization, liveDelegatees } from './delegatee.ts';
import { implement } from './implement.ts';
import { taskAssignmentStatements } from './task-assignment.ts';
import { actorUserIdOf, throwIfClosed } from './write-guards.ts';
import type { ChangeMap } from './change-log-merge.ts';

export const taskDelegateOperation = implement(taskDelegate, async ({ db, actor, organization, workspace, input }) => {
  assertPersonalOrganization(organization);
  const actorUserId = actorUserIdOf(actor);
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .leftJoin('delegatees as d', (join) =>
            join.onRef('d.id', '=', 'tasks.delegatee_id').on('d.organization_id', '=', db.organizationId),
          )
          .leftJoin('users as a', (join) =>
            join.onRef('a.id', '=', 'tasks.assignee_user_id').on('a.organization_id', '=', db.organizationId),
          )
          .select([
            'tasks.assignee_user_id',
            'a.name as assignee_name',
            'tasks.delegatee_id',
            'd.name as delegatee_name',
            'tasks.today_on',
            'tasks.completed_at',
          ])
          .where('tasks.id', '=', taskId)
          .where('tasks.workspace_id', '=', workspaceId)
          .where('tasks.tray', '=', 'backlog')
          .where('tasks.deleted_at', 'is', null),
      ),
    );
    await throwIfClosed(db, workspaceId);
    if (current === undefined) throw new ApiError(404, 'not_found');
    if (current.completed_at !== null) throw new ApiError(409, 'conflict');
    const next =
      input.delegatee_id === null
        ? null
        : await db.first(
            db.statement((q) =>
              liveDelegatees(q, db.organizationId).select(['id', 'name']).where('id', '=', input.delegatee_id!),
            ),
          );
    if (next === undefined) throw new ApiError(404, 'not_found');
    const autoAssign = next !== null && current.assignee_user_id === null;
    if (current.delegatee_id === input.delegatee_id && !autoAssign) return { task_id: taskId };
    let assignee =
      current.assignee_user_id === null ? null : { id: current.assignee_user_id, name: current.assignee_name ?? '' };
    if (autoAssign) {
      const self = await db.first(
        db.statement((q) =>
          q
            .selectFrom('users')
            .select(['id', 'name'])
            .where('id', '=', actorUserId)
            .where('organization_id', '=', db.organizationId)
            .where('disabled_at', 'is', null),
        ),
      );
      if (self === undefined) throw new ApiError(404, 'not_found');
      assignee = self;
    }
    const changes: ChangeMap = {};
    if (current.delegatee_id !== input.delegatee_id)
      changes.delegatee = [
        current.delegatee_id === null ? null : { id: current.delegatee_id, name: current.delegatee_name ?? '' },
        next,
      ];
    if (autoAssign) changes.assignee = [null, assignee];
    const results = await db.batch(
      taskAssignmentStatements(db, {
        workspaceId,
        taskId,
        actorUserId,
        at: now(),
        current,
        assignee,
        todayOn: current.today_on,
        changes,
        delegation: { currentId: current.delegatee_id, nextId: input.delegatee_id, name: next?.name ?? null },
      }),
    );
    if ((results[0]?.changes ?? 0) > 0) return { task_id: taskId };
    await throwIfClosed(db, workspaceId);
  }
  throw new ApiError(409, 'conflict');
});
