import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { orgWikiTree } from '../../../shared/operations/wiki/index.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:wiki');
  const tree = await callOperation(orgWikiTree, {}, { slug: params.slug, fetcher: fetch });
  if (isUnauthenticated(tree)) redirect(307, loginUrl(url));
  return {
    wikiPages: tree.ok ? tree.data.pages : null,
    wikiPage: null,
    wikiNotFound: !tree.ok && tree.status === 404,
    wikiFailed: !tree.ok && tree.status !== 404,
  };
};
