import { resolve } from '$app/paths';
import { callOperation } from './api.ts';
import {
  orgWikiCreate,
  orgWikiPage,
  orgWikiUpdate,
  workspaceWikiCreate,
  workspaceWikiPage,
  workspaceWikiUpdate,
} from '../shared/operations/wiki/index.ts';

type Content = { title: string; body_md: string };

// 組織とワークスペースの違いはここで閉じ、画面と木は同じ Wiki の操作・リンクを使う。
export function wikiClient(slug: string, workspaceId: string | null) {
  return {
    rootHref:
      workspaceId === null
        ? resolve('/[slug]/wiki', { slug })
        : resolve('/[slug]/w/[id]/wiki', { slug, id: workspaceId }),
    pageHref: (pageId: string) =>
      workspaceId === null
        ? resolve('/[slug]/wiki/[pageId]', { slug, pageId })
        : resolve('/[slug]/w/[id]/wiki/[pageId]', { slug, id: workspaceId, pageId }),
    accessLabel: workspaceId === null ? ('orgWikiAccess' as const) : ('wikiAccess' as const),
    treeLabel: workspaceId === null ? ('orgWikiTreeLabel' as const) : ('wikiTreeLabel' as const),
    readPage: (pageId: string) =>
      workspaceId === null
        ? callOperation(orgWikiPage, { page_id: pageId }, { slug })
        : callOperation(workspaceWikiPage, { workspace_id: workspaceId, page_id: pageId }, { slug }),
    createPage: (content: Content, parentId: string | null) =>
      workspaceId === null
        ? callOperation(orgWikiCreate, { ...content, parent_id: parentId }, { slug })
        : callOperation(workspaceWikiCreate, { ...content, workspace_id: workspaceId, parent_id: parentId }, { slug }),
    updatePage: (pageId: string, readVersion: number, content: Content) =>
      workspaceId === null
        ? callOperation(orgWikiUpdate, { ...content, page_id: pageId, read_version: readVersion }, { slug })
        : callOperation(
            workspaceWikiUpdate,
            { ...content, workspace_id: workspaceId, page_id: pageId, read_version: readVersion },
            { slug },
          ),
  };
}

export type WikiClient = ReturnType<typeof wikiClient>;
