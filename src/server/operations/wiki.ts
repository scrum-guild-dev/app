import { now } from '../../shared/clock.ts';
import {
  orgWikiSearch,
  workspaceWikiSearch,
  workspaceWikiCreate,
  workspaceWikiPage,
  workspaceWikiTree,
  workspaceWikiUpdate,
} from '../../shared/operations/wiki/index.ts';
import { wikiTitle } from '../../shared/wiki.ts';
import {
  searchWikiPages,
  type OrganizationDb,
  type WikiScope,
  insertWikiPage,
  readWikiPage,
  readWikiTree,
  updateWikiPage,
  wikiParentFits,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, throwIfClosed } from './write-guards.ts';

export const workspaceWikiTreeOperation = implement(workspaceWikiTree, async ({ db, workspace }) => ({
  pages: await readWikiTree(db, { workspaceId: workspace.workspaceId }),
}));
export const workspaceWikiPageOperation = implement(workspaceWikiPage, async ({ db, workspace, input }) => {
  const page = await readWikiPage(db, { workspaceId: workspace.workspaceId }, input.page_id);
  if (page === undefined) throw new ApiError(404, 'not_found');
  return { page };
});
export const workspaceWikiCreateOperation = implement(
  workspaceWikiCreate,
  async ({ db, workspace, actor, tools, input }) => {
    const scope = { workspaceId: workspace.workspaceId };
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
      await throwIfClosed(db, workspace.workspaceId);
      await checkParent();
      throw new ApiError(409, 'attachment_quota_exceeded');
    }
    const page = await readWikiPage(db, scope, id);
    if (page === undefined) throw new ApiError(404, 'not_found');
    return { page };
  },
);
export const workspaceWikiUpdateOperation = implement(
  workspaceWikiUpdate,
  async ({ db, workspace, actor, tools, input }) => {
    const scope = { workspaceId: workspace.workspaceId };
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
      await throwIfClosed(db, workspace.workspaceId);
      if (page.version !== input.read_version) throw new ApiError(409, 'conflict', { reason: 'changed' });
      throw new ApiError(409, 'attachment_quota_exceeded');
    }
    return { page };
  },
);

async function search(db: OrganizationDb, scope: WikiScope, query: string) {
  const result = await searchWikiPages(db, scope, query);
  if (result.limited) throw new ApiError(409, 'wiki_search_limit');
  return { pages: result.pages };
}
export const orgWikiSearchOperation = implement(orgWikiSearch, async ({ db, input }) =>
  search(db, { organizationId: db.organizationId }, input.query),
);
export const workspaceWikiSearchOperation = implement(workspaceWikiSearch, async ({ db, workspace, input }) =>
  search(db, { workspaceId: workspace.workspaceId }, input.query),
);
