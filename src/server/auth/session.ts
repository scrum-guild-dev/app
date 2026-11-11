// セッションを読み、作り、消す（docs/data-model.md の `sessions`）。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { SESSION_LIFETIME_DAYS, SESSION_TOKEN_PATTERN } from '../../shared/session-cookie.ts';
import { apiTokenSeenAt, commonDb, type CommonDb, type Statement } from '../db/index.ts';
import { randomToken } from './tokens.ts';

// last_used_at を書き直すのは、前回から1時間以上たったときだけ。書き込みを減らすため
const REFRESH_AFTER_MS = 60 * 60 * 1000;
const LIFETIME_MS = SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

export type Session = {
  accountId: string;
  // sessions.token_hash。ログアウトが今のセッションの行を指すのに使う
  tokenHash: string;
  // sessions.created_at。再認証の猶予の起点（延長しても変わらない）
  createdAt: string;
  // last_used_at と expires_at を書き直した。Cookie の期限も延ばす
  refreshed: boolean;
};

// Cookie の値は、ハッシュする前のランダムな ID。DB にはその SHA-256 の小文字の16進だけを持つ
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 無いか、形が違うか、切れているときは undefined。期限を過ぎた行は入れず、書き直しもしない。
// 書き直しは読んだ last_used_at が変わっていないときだけ書く。並行した呼び出しの片方だけが書き、日時が巻き戻らない。
// 書き直しに失敗しても、セッションは読めているのでリクエストは続ける
export async function readSession(
  env: Env,
  token: string | undefined,
  now: Date,
  requestId: string,
): Promise<Session | undefined> {
  if (token === undefined || !SESSION_TOKEN_PATTERN.test(token)) return undefined;
  const tokenHash = await hashSessionToken(token);
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('sessions')
        .select(['account_id', 'created_at', 'last_used_at', 'expires_at'])
        .where('token_hash', '=', tokenHash),
    ),
  );
  if (row === undefined || row.expires_at <= now.toISOString()) return undefined;

  // 日時が読めない行は、書き直して直す
  const idleMs = now.getTime() - Date.parse(row.last_used_at);
  if (idleMs < REFRESH_AFTER_MS)
    return { accountId: row.account_id, tokenHash, createdAt: row.created_at, refreshed: false };

  try {
    const [result] = await db.batch([
      db.statement((q) =>
        q
          .updateTable('sessions')
          .set({ last_used_at: now.toISOString(), expires_at: new Date(now.getTime() + LIFETIME_MS).toISOString() })
          .where('token_hash', '=', tokenHash)
          .where('last_used_at', '=', row.last_used_at),
      ),
    ]);
    return { accountId: row.account_id, tokenHash, createdAt: row.created_at, refreshed: result.changes === 1 };
  } catch (err) {
    // 例外の message に SQL や接続の詳細が混ざりうるので、名前だけを残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId,
        reason: 'セッションの書き直しに失敗した',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return { accountId: row.account_id, tokenHash, createdAt: row.created_at, refreshed: false };
  }
}

// セッションを作り、Cookie に入れるトークンを返す。DB には SHA-256 のハッシュだけを入れ、トークンは残さない。
// replacedToken は、このリクエストが持っていた古いセッションの Cookie の値。ログインし直したら同じ書き込みで消す。
// 期限（expires_at）は呼び出しの時刻 now から30日。作成の時刻（created_at と last_used_at）は、挿入の直前の時刻にする。
export async function createSession(
  env: Env,
  accountId: string,
  now: Date,
  replacedToken: string | undefined,
): Promise<string> {
  const token = randomToken();
  const tokenHash = await hashSessionToken(token);
  const replacedHash =
    replacedToken !== undefined && SESSION_TOKEN_PATTERN.test(replacedToken)
      ? await hashSessionToken(replacedToken)
      : undefined;
  const createdAt = new Date().toISOString();
  const db = commonDb(env);
  const statements: Statement<'common'>[] = [
    db.statement((q) =>
      q.insertInto('sessions').values((eb) => ({
        token_hash: tokenHash,
        account_id: accountId,
        created_at: createdAt,
        last_used_at: createdAt,
        expires_at: new Date(now.getTime() + LIFETIME_MS).toISOString(),
        // 置き換える古い行を消す前に、同じ INSERT の中で最古の確認を読む。
        api_token_seen_at: eb.fn.coalesce(
          eb
            .selectFrom('sessions')
            .select((inner) =>
              inner.fn
                .min<string>(apiTokenSeenAt(inner.ref('api_token_seen_at'), inner.ref('created_at')))
                .as('oldest'),
            )
            .where('account_id', '=', accountId)
            .where('expires_at', '>', now.toISOString()),
          eb.val(createdAt),
        ),
      })),
    ),
  ];
  if (replacedHash !== undefined) {
    statements.push(db.statement((q) => q.deleteFrom('sessions').where('token_hash', '=', replacedHash)));
  }
  await db.batch(statements);
  return token;
}

// その人のセッションを、checkedAt までに作られたものだけ消す。checkedAt より後に作られたセッションは残す
// （消す判定の後にログインし直したセッションを消さないため）。呼ぶのは今はテストだけで、本番の道は無い（退会とアカウントの削除で使う見込み）
export async function deleteSessionsOf(db: CommonDb, accountId: string, checkedAt: Date): Promise<void> {
  await db.batch([
    db.statement((q) =>
      q.deleteFrom('sessions').where('account_id', '=', accountId).where('created_at', '<=', checkedAt.toISOString()),
    ),
  ]);
}

// その人の、今のセッション（currentTokenHash）と同時刻以前に作られた、ほかのセッションを消す文。期限切れも含む。
// 後から作られたセッションは残すので、古い盗難 Cookie の全失効が、本人の再ログインを消せない。
// 他セッションの作成日時が読めなければ最古として消す（不正な日時で盗難セッションが残らないようにする）。
// ほかのアカウントのセッションは account_id で除く。別の文と同じ batch() に入れて送るために、文のまま返す。
// 今のセッションの行（token_hash と account_id が両方一致する行）がまだあるときだけ消す。同時刻に作られた2つのセッションが
// 同時に全失効を実行しても、後から来た側（自分の行が先に消された側）は何も消さず、両方のセッションが消えることを防ぐ。
// 消した行の expires_at を返す（呼び手が期限内の行だけを数えるため。何も消さなかったときは行が返らない）
export function deleteOtherSessionsStatement(
  db: CommonDb,
  accountId: string,
  currentTokenHash: string,
): Statement<'common', { expires_at: string }> {
  return db.statement((q) =>
    q
      .deleteFrom('sessions')
      .where('account_id', '=', accountId)
      .where('token_hash', '!=', currentTokenHash)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('sessions as cs')
            .select('cs.token_hash')
            .where('cs.token_hash', '=', currentTokenHash)
            .where('cs.account_id', '=', accountId)
            // 旧来の SQLite 表記と UTC ミリ秒表記を、文字列の大小でなく同じ日時として比較する。
            // 今の作成日時もこの DELETE で読むので、事前の認証からの間に行が消えても何も消さない。
            .where(({ eb, fn }) =>
              eb(
                fn.coalesce(fn<number | null>('julianday', ['sessions.created_at']), eb.val(-1)),
                '<=',
                fn<number>('julianday', ['cs.created_at']),
              ),
            ),
        ),
      )
      .returning('expires_at'),
  );
}

// その人の、今のセッション（currentTokenHash）と同時刻以前に作られた、ほかのセッションを消し、行数（changes。期限切れも含む）を返す。
// 全失効の応答の件数（期限内の行だけ）とは意味が違う。
// 今のセッションと、ほかのアカウントのセッションは残す。本番の道（credentials-revoke-all）は、トークンの取り消しと
// 同じ batch() に入れるため、文（deleteOtherSessionsStatement）を直に使う。この関数を呼ぶのは今はテストだけ
export async function deleteOtherSessionsOf(
  db: CommonDb,
  accountId: string,
  currentTokenHash: string,
): Promise<number> {
  const [result] = await db.batch([deleteOtherSessionsStatement(db, accountId, currentTokenHash)]);
  return result.changes;
}
