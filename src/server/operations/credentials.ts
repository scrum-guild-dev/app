// 今のセッション以外のすべてのセッションとすべての API トークンを無効にする処理（定義は src/shared/operations/session/credentials.ts）。
// 共通の2文（今のセッション以外のセッションを消す文、取り消していないトークンを取り消す文）を1つの batch() で送る。
// どちらかだけが残る半端な状態を作らない。件数は batch() の結果の changes から取る。今のセッションは消さず、再認証は求めない
import { credentialsRevokeAll } from '../../shared/operations/session/index.ts';
import { revokeAllApiTokensStatement } from '../auth/api-token.ts';
import { deleteOtherSessionsStatement } from '../auth/session.ts';
import { implement } from './implement.ts';

export const credentialsRevokeAllOperation = implement(credentialsRevokeAll, async ({ db, accountId, session }) => {
  const [sessions, tokens] = await db.batch([
    deleteOtherSessionsStatement(db, accountId, session.tokenHash),
    revokeAllApiTokensStatement(db, accountId, new Date()),
  ]);
  return { revoked_sessions: sessions.changes, revoked_tokens: tokens.changes };
});
