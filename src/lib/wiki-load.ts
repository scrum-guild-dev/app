import type { OutputOf } from '../shared/operations/define.ts';
import type { workspaceWikiPage, workspaceWikiTree } from '../shared/operations/wiki/index.ts';

export type WikiData = {
  wikiPages: OutputOf<typeof workspaceWikiTree>['pages'] | null;
  wikiPage: OutputOf<typeof workspaceWikiPage>['page'] | null;
  wikiNotFound: boolean;
  wikiFailed: boolean;
};
