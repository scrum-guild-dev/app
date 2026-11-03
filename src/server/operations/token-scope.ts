// API トークンで呼べるかの判定。呼び出しの 403（register.ts の checkTokenScope）と一覧の絞り（operation-list.ts）が同じ関数を使う
import type { AnyOperationDefinition } from '../../shared/operations/define.ts';

// 本文がバイナリの操作（body: 'binary'）は、CLI と MCP が JSON でしか呼べないので一覧から外し、同じ判定でトークンの呼び出しも断る
export function tokenAllows(definition: AnyOperationDefinition, scope: 'read' | 'write'): boolean {
  if (definition.permission === 'operator' || definition.cookieOnly === true || definition.body === 'binary') {
    return false;
  }
  if (scope === 'write') return definition.mode === 'read' || definition.mode === 'write';
  if (scope === 'read') return definition.mode === 'read';
  return false;
}
