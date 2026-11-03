import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../../../lib/login-redirect.ts';
import { workspaceWikiPage, workspaceWikiTree } from '../../../../../../shared/operations/wiki/index.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:wiki');
  const [tree, detail] = await Promise.all([
    callOperation(workspaceWikiTree, { workspace_id: params.id }, { slug: params.slug, fetcher: fetch }),
    callOperation(
      workspaceWikiPage,
      { workspace_id: params.id, page_id: params.pageId },
      { slug: params.slug, fetcher: fetch },
    ),
  ]);
  if (isUnauthenticated(tree) || isUnauthenticated(detail)) redirect(307, loginUrl(url));
  return {
    wikiPages: tree.ok ? tree.data.pages : null,
    wikiPage: detail.ok ? detail.data.page : null,
    wikiNotFound: !detail.ok && detail.status === 404,
    wikiFailed: !tree.ok || (!detail.ok && detail.status !== 404),
  };
};
