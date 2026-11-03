import { resolve } from '$app/paths';
import { callOperation } from './api.ts';
import {
  orgWikiCreate,
  orgWikiUpload,
  orgWikiMove,
  orgWikiPage,
  orgWikiRevisions,
  orgWikiUpdate,
  workspaceWikiCreate,
  workspaceWikiUpload,
  workspaceWikiMove,
  workspaceWikiPage,
  workspaceWikiRevisions,
  workspaceWikiUpdate,
} from '../shared/operations/wiki/index.ts';
import type { WikiUploadFile } from '../shared/wiki-transfer.ts';

type Content = { title: string; body_md: string };

// 組織とワークスペースの違いはここで閉じ、画面と木は同じ Wiki の操作・リンクを使う。
export function wikiClient(slug: string, workspaceId: string | null) {
  return {
    upload: (files: WikiUploadFile[], parentId: string | null) =>
      workspaceId === null
        ? callOperation(orgWikiUpload, { files, parent_id: parentId }, { slug })
        : callOperation(workspaceWikiUpload, { files, parent_id: parentId, workspace_id: workspaceId }, { slug }),
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
    readPage: (pageId: string, revision?: number) =>
      workspaceId === null
        ? callOperation(orgWikiPage, { page_id: pageId, revision }, { slug })
        : callOperation(workspaceWikiPage, { workspace_id: workspaceId, page_id: pageId, revision }, { slug }),
    readRevisions: (pageId: string) =>
      workspaceId === null
        ? callOperation(orgWikiRevisions, { page_id: pageId }, { slug })
        : callOperation(workspaceWikiRevisions, { workspace_id: workspaceId, page_id: pageId }, { slug }),
    createPage: (content: Content, parentId: string | null) =>
      workspaceId === null
        ? callOperation(orgWikiCreate, { ...content, parent_id: parentId }, { slug })
        : callOperation(workspaceWikiCreate, { ...content, workspace_id: workspaceId, parent_id: parentId }, { slug }),
    movePage: (pageId: string, parentId: string | null, afterId?: string | null) =>
      workspaceId === null
        ? callOperation(orgWikiMove, { page_id: pageId, parent_id: parentId, after_page_id: afterId }, { slug })
        : callOperation(
            workspaceWikiMove,
            { workspace_id: workspaceId, page_id: pageId, parent_id: parentId, after_page_id: afterId },
            { slug },
          ),
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
