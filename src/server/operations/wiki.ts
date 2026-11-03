import { now } from '../../shared/clock.ts';
import {
  orgWikiRevisions,
  workspaceWikiRevisions,
  orgWikiCreate,
  orgWikiPage,
  orgWikiTree,
  orgWikiUpdate,
  workspaceWikiCreate,
  workspaceWikiPage,
  workspaceWikiTree,
  workspaceWikiUpdate,
} from '../../shared/operations/wiki/index.ts';
import { wikiTitle } from '../../shared/wiki.ts';
import {
  insertWikiPage,
  readWikiPage,
  readWikiRevisions,
  readWikiTree,
  updateWikiPage,
  wikiParentFits,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement, type ContextOf } from './implement.ts';
import { actorUserIdOf, throwIfClosed } from './write-guards.ts';

type WikiScope = Parameters<typeof readWikiPage>[1];

export const workspaceWikiTreeOperation = implement(workspaceWikiTree, async ({ db, workspace }) => ({
  pages: await readWikiTree(db, { workspaceId: workspace.workspaceId }),
}));
export const workspaceWikiPageOperation = implement(workspaceWikiPage, async ({ db, workspace, input }) => {
  const page = await readWikiPage(db, { workspaceId: workspace.workspaceId }, input.page_id, input.revision);
  if (page === undefined) throw new ApiError(404, 'not_found');
  return { page };
});
async function createPage({ db, actor, tools, input }: ContextOf<typeof orgWikiCreate>, scope: WikiScope) {
  const checkParent = async () => {
    if (input.parent_id !== null && (await readWikiPage(db, scope, input.parent_id)) === undefined)
      throw new ApiError(404, 'not_found');
    if (!(await wikiParentFits(db, scope, input.parent_id)))
      throw new ApiError(409, 'conflict', { reason: 'too_deep' });
  };
  await checkParent();
  const at = now();
  const id = uuidv7(at);
  const title = wikiTitle(input.title, input.body_md);
  if (title === null) throw new ApiError(400, 'invalid_input');
  const { attachmentQuotaBytes } = await tools.readOrganization();
  if (
    !(await insertWikiPage(
      db,
      scope,
      id,
      input.parent_id,
      { title, body_md: input.body_md, userId: actorUserIdOf(actor), at: at.toISOString() },
      attachmentQuotaBytes,
    ))
  ) {
    if ('workspaceId' in scope) await throwIfClosed(db, scope.workspaceId);
    await checkParent();
    throw new ApiError(409, 'attachment_quota_exceeded');
  }
  const page = await readWikiPage(db, scope, id);
  if (page === undefined) throw new ApiError(404, 'not_found');
  return { page };
}
async function updatePage({ db, actor, tools, input }: ContextOf<typeof orgWikiUpdate>, scope: WikiScope) {
  const current = await readWikiPage(db, scope, input.page_id);
  if (current === undefined) throw new ApiError(404, 'not_found');
  if (current.version !== input.read_version) throw new ApiError(409, 'conflict', { reason: 'changed' });
  const title = wikiTitle(input.title, input.body_md);
  if (title === null) throw new ApiError(400, 'invalid_input');
  if (current.title === title && current.body_md === input.body_md) return { page: current };
  const { attachmentQuotaBytes } = await tools.readOrganization();
  const saved = await updateWikiPage(
    db,
    scope,
    input.page_id,
    input.read_version,
    { title, body_md: input.body_md, userId: actorUserIdOf(actor), at: now().toISOString() },
    attachmentQuotaBytes,
  );
  const page = await readWikiPage(db, scope, input.page_id);
  if (page === undefined) throw new ApiError(404, 'not_found');
  if (!saved) {
    if ('workspaceId' in scope) await throwIfClosed(db, scope.workspaceId);
    if (page.version !== input.read_version) throw new ApiError(409, 'conflict', { reason: 'changed' });
    throw new ApiError(409, 'attachment_quota_exceeded');
  }
  return { page };
}

export const workspaceWikiCreateOperation = implement(workspaceWikiCreate, (context) =>
  createPage(context, { workspaceId: context.workspace.workspaceId }),
);
export const workspaceWikiUpdateOperation = implement(workspaceWikiUpdate, (context) =>
  updatePage(context, { workspaceId: context.workspace.workspaceId }),
);
export const orgWikiTreeOperation = implement(orgWikiTree, async ({ db }) => ({
  pages: await readWikiTree(db, { organizationId: db.organizationId }),
}));
export const orgWikiPageOperation = implement(orgWikiPage, async ({ db, input }) => {
  const page = await readWikiPage(db, { organizationId: db.organizationId }, input.page_id, input.revision);
  if (page === undefined) throw new ApiError(404, 'not_found');
  return { page };
});
export const orgWikiCreateOperation = implement(orgWikiCreate, (context) =>
  createPage(context, { organizationId: context.db.organizationId }),
);
export const orgWikiUpdateOperation = implement(orgWikiUpdate, (context) =>
  updatePage(context, { organizationId: context.db.organizationId }),
);

export const workspaceWikiRevisionsOperation = implement(workspaceWikiRevisions, async ({ db, workspace, input }) => {
  const revisions = await readWikiRevisions(db, { workspaceId: workspace.workspaceId }, input.page_id);
  if (revisions === undefined) throw new ApiError(404, 'not_found');
  return { revisions };
});
export const orgWikiRevisionsOperation = implement(orgWikiRevisions, async ({ db, input }) => {
  const revisions = await readWikiRevisions(db, { organizationId: db.organizationId }, input.page_id);
  if (revisions === undefined) throw new ApiError(404, 'not_found');
  return { revisions };
});
