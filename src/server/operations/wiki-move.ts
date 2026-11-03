import { orgWikiMove, workspaceWikiMove } from '../../shared/operations/wiki/index.ts';
import { implement } from './implement.ts';
export const orgWikiMoveOperation = implement(orgWikiMove, async () => {
  throw new Error('未実装');
});
export const workspaceWikiMoveOperation = implement(workspaceWikiMove, async () => {
  throw new Error('未実装');
});
