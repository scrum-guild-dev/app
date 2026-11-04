import { now } from '../../shared/clock.ts';
import { orgWikiDelete, workspaceWikiDelete } from '../../shared/operations/wiki/index.ts';
import { deleteWikiPage, readWikiPage, type WikiScope } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement, type ContextOf } from './implement.ts';
import { actorUserIdOf, isLeaderOrAdmin, throwIfClosed } from './write-guards.ts';

async function remove({ db, actor, input }: ContextOf<typeof orgWikiDelete>, scope: WikiScope, canManage: boolean) {
  const userId = actorUserIdOf(actor);
  const check = async () => {
    const current = await readWikiPage(db, scope, input.page_id);
    if (!current) throw new ApiError(404, 'not_found');
    if (!canManage && current.created_by !== userId) throw new ApiError(403, 'forbidden');
    if (input.read_parent_id !== undefined && input.read_parent_id !== current.parent_id)
      throw new ApiError(409, 'conflict', { reason: 'changed' });
    return current;
  };
  const current = await check();
  if (!(await deleteWikiPage(db, scope, current, userId, now().toISOString()))) {
    await check();
    if ('workspaceId' in scope) await throwIfClosed(db, scope.workspaceId);
    throw new ApiError(409, 'conflict', { reason: 'changed' });
  }
  return { page_id: current.id };
}

export const orgWikiDeleteOperation = implement(orgWikiDelete, (context) =>
  remove(context, { organizationId: context.db.organizationId }, context.actor.isAdmin),
);
export const workspaceWikiDeleteOperation = implement(workspaceWikiDelete, (context) =>
  remove(context, { workspaceId: context.workspace.workspaceId }, isLeaderOrAdmin(context.actor, context.workspace)),
);
