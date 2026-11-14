import { now } from '../../shared/clock.ts';
import { epicCancel, epicUncancel } from '../../shared/operations/epic/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, isLeaderOrAdmin, openWorkspace, throwIfClosed } from './write-guards.ts';

async function changeCancellation(
  db: OrganizationDb,
  workspaceId: string,
  epicId: string,
  userId: string,
  leader: boolean,
  canceling: boolean,
) {
  const user = await db.first(
    db.statement((q) =>
      q.selectFrom('users').select('name').where('id', '=', userId).where('organization_id', '=', db.organizationId),
    ),
  );
  if (user === undefined) throw new ApiError(404, 'not_found');

  for (let attempt = 0; attempt < 3; attempt++) {
    const epic = await db.first(
      db.statement((q) =>
        q
          .selectFrom('epics')
          .leftJoin('users as canceled_by', (join) =>
            join
              .onRef('canceled_by.id', '=', 'epics.canceled_by')
              .on('canceled_by.organization_id', '=', db.organizationId),
          )
          .select([
            'epics.requester_user_id',
            'epics.completed_at',
            'epics.canceled_at',
            'epics.canceled_by',
            'canceled_by.name as canceled_by_name',
          ])
          .where('epics.id', '=', epicId)
          .where('epics.workspace_id', '=', workspaceId)
          .where('epics.deleted_at', 'is', null),
      ),
    );
    if (epic === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (!leader && epic.requester_user_id !== userId) throw new ApiError(403, 'forbidden');
    await throwIfClosed(db, workspaceId);
    if (epic.completed_at !== null) throw new ApiError(409, 'epic_finished');
    if ((epic.canceled_at !== null) === canceling) throw new ApiError(409, 'conflict');

    const at = now();
    const timestamp = at.toISOString();
    const canceledAt = canceling ? timestamp : null;
    const canceledBy = canceling ? userId : null;
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ canceled_at: canceledAt, canceled_by: canceledBy, updated_at: timestamp })
          .where('id', '=', epicId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .where('canceled_at', 'is', epic.canceled_at)
          .where('canceled_by', 'is', epic.canceled_by)
          .$if(!leader, (qb) => qb.where('requester_user_id', '=', userId))
          .where((eb) => eb.exists(openWorkspace(q, db.organizationId, workspaceId))),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(uuidv7(at)).as('id'),
                eb.val(db.organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(userId).as('actor_user_id'),
                eb.val('epic').as('entity_type'),
                eb.val(epicId).as('entity_id'),
                eb.val(canceling ? 'cancel' : 'uncancel').as('action'),
                eb
                  .val(
                    JSON.stringify({
                      canceled_at: [epic.canceled_at, canceledAt],
                      canceled_by: [
                        epic.canceled_by === null ? null : { id: epic.canceled_by, name: epic.canceled_by_name },
                        canceling ? { id: userId, name: user.name } : null,
                      ],
                    }),
                  )
                  .as('changes_json'),
                eb.val(timestamp).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { epic_id: epicId };
    await throwIfClosed(db, workspaceId);
  }
  throw new ApiError(409, 'conflict');
}

export const epicCancelOperation = implement(epicCancel, ({ db, actor, workspace, input }) =>
  changeCancellation(
    db,
    workspace.workspaceId,
    input.epic_id,
    actorUserIdOf(actor),
    isLeaderOrAdmin(actor, workspace),
    true,
  ),
);

export const epicUncancelOperation = implement(epicUncancel, ({ db, actor, workspace, input }) =>
  changeCancellation(
    db,
    workspace.workspaceId,
    input.epic_id,
    actorUserIdOf(actor),
    isLeaderOrAdmin(actor, workspace),
    false,
  ),
);
