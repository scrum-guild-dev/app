import { orgWikiMove, workspaceWikiMove } from '../../shared/operations/wiki/index.ts';
import { readWikiPage, wikiMoveProblem, writeWikiMove, type WikiScope } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement, type ContextOf } from './implement.ts';
import { MAX_TIES, placeAfter, placeFirst, placeLast } from './move-position.ts';
import { throwIfClosed } from './write-guards.ts';

async function move({ db, input }: ContextOf<typeof orgWikiMove>, scope: WikiScope) {
  if (input.after_page_id === input.page_id) throw new ApiError(400, 'invalid_input');
  const check = async () => {
    const current = await readWikiPage(db, scope, input.page_id);
    if (!current || (input.parent_id !== null && !(await readWikiPage(db, scope, input.parent_id))))
      throw new ApiError(404, 'not_found');
    const problem = await wikiMoveProblem(db, scope, input.page_id, input.parent_id);
    if (problem) throw new ApiError(409, 'conflict', { reason: problem });
    return current;
  };
  const current = await check();
  const query = (q: Parameters<Parameters<typeof db.statement>[0]>[0]) => {
    const base = q
      .selectFrom('wiki_pages')
      .select(['id', 'parent_id', 'position'])
      .where('parent_id', 'is', input.parent_id)
      .where('deleted_at', 'is', null)
      .where('id', '!=', current.id);
    return 'workspaceId' in scope
      ? base.where('workspace_id', '=', scope.workspaceId)
      : base.where('organization_id', '=', scope.organizationId);
  };
  const snapshots: { id: string; parent_id: string | null; position: string }[] = [];
  let plan;
  if (input.after_page_id === undefined || input.after_page_id === null) {
    const first = input.after_page_id === null;
    const edge = await db.first(
      db.statement((q) =>
        query(q)
          .orderBy('position', first ? 'asc' : 'desc')
          .orderBy('id', first ? 'asc' : 'desc')
          .limit(1),
      ),
    );
    if (edge) snapshots.push(edge);
    plan = first ? placeFirst(edge) : placeLast(edge);
  } else {
    const after = await db.first(db.statement((q) => query(q).where('id', '=', input.after_page_id!)));
    if (!after) throw new ApiError(404, 'not_found');
    const ties = await db.rows(
      db.statement((q) =>
        query(q)
          .where('position', '=', after.position)
          .where('id', '>', after.id)
          .orderBy('id')
          .limit(MAX_TIES + 1),
      ),
    );
    const next = await db.first(
      db.statement((q) => query(q).where('position', '>', after.position).orderBy('position').orderBy('id').limit(1)),
    );
    snapshots.push(after, ...ties, ...(next ? [next] : []));
    plan = placeAfter(after, ties, next);
  }
  if (!(await writeWikiMove(db, scope, current, input.parent_id, plan, snapshots))) {
    if ('workspaceId' in scope) await throwIfClosed(db, scope.workspaceId);
    await check();
    if (input.after_page_id && !(await db.first(db.statement((q) => query(q).where('id', '=', input.after_page_id!)))))
      throw new ApiError(404, 'not_found');
    throw new ApiError(409, 'conflict', { reason: 'changed' });
  }
  return { page_id: current.id, parent_id: input.parent_id };
}
export const orgWikiMoveOperation = implement(orgWikiMove, (context) =>
  move(context, { organizationId: context.db.organizationId }),
);
export const workspaceWikiMoveOperation = implement(workspaceWikiMove, (context) =>
  move(context, { workspaceId: context.workspace.workspaceId }),
);
