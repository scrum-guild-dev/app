// 今のセッションと同時刻以前のほかのセッションと、すべての API トークンを無効にする処理（定義は src/shared/operations/session/credentials.ts）。
// 共通の2文（同時刻以前のほかのセッションを消す文、取り消していないトークンを取り消す文）を1つの batch() で送る。
// どちらかだけが残る半端な状態を作らない。消すのも取り消すのも期限切れを含むすべての対象行だが、
// 応答の件数は、2文が RETURNING で返した行のうち期限内（expires_at > 今）の行の数（期限切れの行は数えない）。今のセッションは消さず、再認証は求めない。
// 2文とも「今のセッションの行がまだある」ときだけ書く。同時に実行して自分の行を先に消された側は、何も書かず（行が返らず）件数 0 で返す
import { credentialsRevokeAll } from '../../shared/operations/session/index.ts';
import { revokeAllApiTokensStatement } from '../auth/api-token.ts';
import { deleteOtherSessionsStatement } from '../auth/session.ts';
import { implement } from './implement.ts';

export const credentialsRevokeAllOperation = implement(credentialsRevokeAll, async ({ db, accountId, session }) => {
  // 取り消す時刻と期限内かどうかの比較に、同じ now を使う。ちょうど now に切れる行は期限内に数えない（ISO 文字列どうしの比較）
  const now = new Date();
  const nowIso = now.toISOString();
  const [sessions, tokens] = await db.batch([
    deleteOtherSessionsStatement(db, accountId, session.tokenHash),
    revokeAllApiTokensStatement(db, accountId, now, session.tokenHash),
  ]);
  const unexpired = (rows: readonly { expires_at: string }[]): number =>
    rows.filter((row) => row.expires_at > nowIso).length;
  return { revoked_sessions: unexpired(sessions.rows), revoked_tokens: unexpired(tokens.rows) };
});
