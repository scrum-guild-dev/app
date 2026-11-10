// task-assign と task-delegate が共有する、担当を含むタスク更新・履歴・討伐隊の文。
import type { ExpressionBuilder, OrganizationDb, OrganizationTables } from '../db/index.ts';
import { changeLogStatement, type ChangeMap } from './change-log-merge.ts';
import { taskAssigneePartyStatements } from './epic-party.ts';
import { activeMemberName, openWorkspace } from './write-guards.ts';

type TaskExpression = ExpressionBuilder<OrganizationTables, 'tasks'>;

export function taskAssignmentStatements(
  db: OrganizationDb,
  params: {
    workspaceId: string;
    taskId: string;
    actorUserId: string;
    at: Date;
    current: { assignee_user_id: string | null; today_on: string | null };
    assignee: { id: string; name: string } | null;
    todayOn: string | null;
    changes: ChangeMap;
    // 依頼先の付け外しは、読んだ依頼先と未完了のバックログであることも条件にする。
    delegation?: { currentId: string | null; nextId: string | null; name: string | null };
  },
) {
  const { workspaceId, taskId, actorUserId, at, current, assignee, todayOn, changes, delegation } = params;
  const organizationId = db.organizationId;
  const stamp = at.toISOString();
  const delegationCondition = (eb: TaskExpression) => {
    if (delegation === undefined) return eb.val(true);
    return eb.and([
      eb('delegatee_id', 'is', delegation.currentId),
      eb('tray', '=', 'backlog'),
      ...(delegation.nextId === null
        ? []
        : [
            eb.exists(
              eb
                .selectFrom('delegatees')
                .select('id')
                .where('id', '=', delegation.nextId)
                .where('organization_id', '=', organizationId)
                .where('deleted_at', 'is', null)
                // 履歴の名前が、書く時点の名前と食い違わないようにする。
                .where('name', '=', delegation.name!),
            ),
          ]),
    ]);
  };
  return [
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({
          assignee_user_id: assignee?.id ?? null,
          today_on: todayOn,
          updated_at: stamp,
          ...(delegation === undefined ? {} : { delegatee_id: delegation.nextId }),
        })
        .where((eb) =>
          eb.and([
            eb('id', '=', taskId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', 'is', null),
            eb('completed_at', 'is', null),
            eb('assignee_user_id', 'is', current.assignee_user_id),
            eb('today_on', 'is', current.today_on),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
            delegationCondition(eb),
            // 担当を付ける場合は、自動設定でも現在の所属を再確認する。依頼先だけを変える場合は既存の担当を保持する。
            ...(assignee === null || (delegation !== undefined && current.assignee_user_id !== null)
              ? []
              : [eb.exists(activeMemberName(q, organizationId, workspaceId, assignee.id))]),
          ]),
        ),
    ),
    changeLogStatement(
      db,
      { entityType: 'task', workspaceId, entityId: taskId },
      { actorUserId, at, changes, mergeTarget: undefined },
    ),
    ...(assignee === null || (delegation !== undefined && current.assignee_user_id !== null)
      ? []
      : taskAssigneePartyStatements(db, {
          workspaceId,
          taskId,
          assignee,
          actorUserId,
          at,
          taskUpdatedAt: stamp,
        })),
  ];
}
