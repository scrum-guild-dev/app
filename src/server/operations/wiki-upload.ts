import { now } from '../../shared/clock.ts';
import { orgWikiUpload, workspaceWikiUpload } from '../../shared/operations/wiki/index.ts';
import { wikiUploadTitle } from '../../shared/wiki-transfer.ts';
import { insertWikiPages, readWikiPage, wikiParentFits, type WikiScope } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement, type ContextOf } from './implement.ts';
import { actorUserIdOf, throwIfClosed } from './write-guards.ts';

async function upload({ db, actor, tools, input }: ContextOf<typeof orgWikiUpload>, scope: WikiScope) {
  const checkParent = async () => {
    if (input.parent_id !== null && !(await readWikiPage(db, scope, input.parent_id)))
      throw new ApiError(404, 'not_found');
    if (!(await wikiParentFits(db, scope, input.parent_id)))
      throw new ApiError(409, 'conflict', { reason: 'too_deep' });
  };
  await checkParent();
  const at = now();
  const quota = (await tools.readOrganization()).attachmentQuotaBytes;
  const pages = await insertWikiPages(
    db,
    scope,
    input.parent_id,
    input.files.map((file) => ({
      id: uuidv7(at),
      title: wikiUploadTitle(file)!,
      body_md: file.body_md,
    })),
    actorUserIdOf(actor),
    at.toISOString(),
    quota,
  );
  if (pages === null) {
    if ('workspaceId' in scope) await throwIfClosed(db, scope.workspaceId);
    await checkParent();
    throw new ApiError(409, 'attachment_quota_exceeded');
  }
  return { pages };
}
export const orgWikiUploadOperation = implement(orgWikiUpload, (context) =>
  upload(context, { organizationId: context.db.organizationId }),
);
export const workspaceWikiUploadOperation = implement(workspaceWikiUpload, (context) =>
  upload(context, { workspaceId: context.workspace.workspaceId }),
);
