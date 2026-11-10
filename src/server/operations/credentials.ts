// 今のセッションと同時刻以前のほかのセッションと、すべての API トークンを無効にする処理（定義は src/shared/operations/session/credentials.ts）。
// 共通の2文（同時刻以前のほかのセッションを消す文、取り消していないトークンを取り消す文）を1つの batch() で送る。
// どちらかだけが残る半端な状態を作らない。件数は batch() の結果の changes から取る（この実行が変えた行の数）。今のセッションは消さず、再認証は求めない。
// 2文とも「今のセッションの行がまだある」ときだけ書く。同時に実行して自分の行を先に消された側は、何も書かずに件数 0 で返す
import { credentialsRevokeAll } from '../../shared/operations/session/index.ts';
import { revokeAllApiTokensStatement } from '../auth/api-token.ts';
import { deleteOtherSessionsStatement } from '../auth/session.ts';
import { implement } from './implement.ts';

export const credentialsRevokeAllOperation = implement(credentialsRevokeAll, async ({ db, accountId, session }) => {
  const [sessions, tokens] = await db.batch([
    deleteOtherSessionsStatement(db, accountId, session.tokenHash),
    revokeAllApiTokensStatement(db, accountId, new Date(), session.tokenHash),
  ]);
  return { revoked_sessions: sessions.changes, revoked_tokens: tokens.changes };
});
