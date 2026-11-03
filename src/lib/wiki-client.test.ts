import { afterEach, expect, test, vi } from 'vitest';
import { wikiClient } from './wiki-client.ts';

vi.mock('$app/paths', () => ({
  resolve: (route: string, params: Record<string, string>) =>
    '/base' + route.replace(/\[([^\]]+)\]/g, (_, key: string) => encodeURIComponent(params[key]!)),
}));

afterEach(() => vi.unstubAllGlobals());

test.each([
  { workspaceId: null, prefix: 'org-wiki', path: '/base/aoba/wiki' },
  { workspaceId: 'workspace-1', prefix: 'workspace-wiki', path: '/base/aoba/w/workspace-1/wiki' },
])('同じ Wiki のリンクと操作を選び、範囲を混ぜない: $prefix', async ({ workspaceId, prefix, path }) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ page: {} }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const wiki = wikiClient('aoba', workspaceId);
  expect(wiki.rootHref).toBe(path);
  expect(wiki.pageHref('page-1')).toBe(path + '/page-1');
  expect(wiki.accessLabel).toBe(workspaceId === null ? 'orgWikiAccess' : 'wikiAccess');
  expect(wiki.treeLabel).toBe(workspaceId === null ? 'orgWikiTreeLabel' : 'wikiTreeLabel');
  const content = { title: '手順', body_md: '本文' };
  await wiki.readPage('page-1');
  await wiki.readPage('page-1', 2);
  await wiki.readRevisions('page-1');
  await wiki.createPage(content, 'parent-1');
  await wiki.updatePage('page-1', 3, content);
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.map(([url]) => url)).toEqual([
    `/api/aoba/${prefix}-page`,
    `/api/aoba/${prefix}-page`,
    `/api/aoba/${prefix}-revisions`,
    `/api/aoba/${prefix}-create`,
    `/api/aoba/${prefix}-update`,
  ]);
  const scope = workspaceId === null ? {} : { workspace_id: workspaceId };
  expect(calls.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
    { ...scope, page_id: 'page-1' },
    { ...scope, page_id: 'page-1', revision: 2 },
    { ...scope, page_id: 'page-1' },
    { ...scope, ...content, parent_id: 'parent-1' },
    { ...scope, ...content, page_id: 'page-1', read_version: 3 },
  ]);
});
