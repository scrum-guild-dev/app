// 今のセッション以外のすべてのセッションとすべての API トークンを無効にする処理（定義は src/shared/operations/session/credentials.ts）
import { credentialsRevokeAll } from '../../shared/operations/session/index.ts';
import { implement } from './implement.ts';

export const credentialsRevokeAllOperation = implement(credentialsRevokeAll, async () => {
  throw new Error('未実装');
});
