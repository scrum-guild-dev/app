// 発行の知らせは Cookie のセッションごとに確かめる。ほかのセッションの確認は書き換えない。
import type { ApiTokenScope } from '../../shared/api-token.ts';
import { tokenNotice, tokenNoticeSeen } from '../../shared/operations/session/index.ts';
import { implement } from './implement.ts';
import { apiTokenSeenAt } from '../db/index.ts';

export const tokenNoticeOperation = implement(tokenNotice, async ({ db, accountId, session }) => {
  // 件数と最新の発行を同じ文で読む。期限切れの行も掃除されるまでは知らせ、取り消し済みも除かない。
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('api_tokens as t')
        .innerJoin('sessions as s', 's.account_id', 't.account_id')
        .select(['t.name', 't.scope', 't.created_at', 't.revoked_at'])
        .select((eb) => eb.fn.countAll<number>().over().as('count'))
        .where('t.account_id', '=', accountId)
        .where('s.token_hash', '=', session.tokenHash)
        .where((eb) => eb('t.created_at', '>', apiTokenSeenAt(eb.ref('s.api_token_seen_at'), eb.ref('s.created_at'))))
        .orderBy('t.created_at', 'desc')
        .orderBy('t.token_hash')
        .limit(1),
    ),
  );
  return row === undefined
    ? { count: 0, latest: null }
    : {
        count: row.count,
        latest: {
          name: row.name,
          scope: row.scope as ApiTokenScope,
          created_at: row.created_at,
          revoked: row.revoked_at !== null,
        },
      };
});

export const tokenNoticeSeenOperation = implement(tokenNoticeSeen, async ({ db, accountId, session, input }) => {
  // 表示後に増えた発行を消さず、未来の入力も最新の発行までに丸める。比較と更新は1文にする。
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('sessions')
        .set((eb) => {
          const current = apiTokenSeenAt(eb.ref('api_token_seen_at'), eb.ref('created_at'));
          const latest = eb
            .selectFrom('api_tokens')
            .select((inner) => inner.fn.max<string>('created_at').as('latest'))
            .where('account_id', '=', accountId);
          return {
            api_token_seen_at: eb.fn<string>('max', [
              current,
              eb.fn<string>('min', [eb.val(input.created_at), eb.fn.coalesce(latest, current)]),
            ]),
          };
        })
        .where('account_id', '=', accountId)
        .where('token_hash', '=', session.tokenHash),
    ),
  ]);
  return {};
});
