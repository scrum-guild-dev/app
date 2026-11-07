// 接続の一覧、登録、範囲の候補と保存の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { connectionCreate } from './connection-create.ts';
import { connectionList } from './connection-list.ts';
import { connectionScopeCandidates } from './connection-scope-candidates.ts';
import { connectionScopesSave } from './connection-scopes-save.ts';
import { connectionSync } from './connection-sync.ts';

export { connectionCreate, connectionList, connectionScopeCandidates, connectionScopesSave, connectionSync };
export * from './connection-sync.ts';
export * from './connection.ts';

export const connectionOperations: readonly AnyOperationDefinition[] = [
  connectionList,
  connectionCreate,
  connectionScopeCandidates,
  connectionScopesSave,
  connectionSync,
];
