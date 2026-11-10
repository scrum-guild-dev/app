import { now } from '../../shared/clock.ts';
import { notificationList, notificationRead } from '../../shared/operations/notification.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { actorUserIdOf } from './write-guards.ts';

export const notificationListOperation = implement(notificationList, async ({ db, actor, input }) => {
  const userId = actorUserIdOf(actor);
  // カーソルの行が消えていても、値の比較で続きを読める。
  const [list, count] = await db.batch([
    db.statement((q) => {
      let query = q
        .selectFrom('notifications as n')
        .innerJoin('users as recipient', 'recipient.id', 'n.user_id')
        .select(['n.id', 'n.kind', 'n.payload_json', 'n.read_at', 'n.created_at'])
        .where('recipient.organization_id', '=', db.organizationId)
        .where('recipient.id', '=', userId);
      if (input.unread_only === true) query = query.where('n.read_at', 'is', null);
      const before = input.before;
      if (before !== undefined)
        query = query.where((eb) =>
          eb.or([
            eb('n.created_at', '<', before.created_at),
            eb.and([eb('n.created_at', '=', before.created_at), eb('n.id', '<', before.id)]),
          ]),
        );
      return query.orderBy('n.created_at', 'desc').orderBy('n.id', 'desc').limit(51);
    }),
    db.statement((q) =>
      q
        .selectFrom('notifications as n')
        .innerJoin('users as recipient', 'recipient.id', 'n.user_id')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('recipient.organization_id', '=', db.organizationId)
        .where('recipient.id', '=', userId)
        .where('n.read_at', 'is', null),
    ),
  ]);
  const rows = list.rows.slice(0, 50);
  const last = rows.at(-1);
  return {
    notifications: rows.map(({ payload_json, ...row }) => ({
      ...row,
      // 今回書く容量警告だけがこの値を持つ。他の種類は UI が汎用の文面で扱う。
      payload: payloadOf(payload_json),
    })),
    next: list.rows.length > 50 && last !== undefined ? { created_at: last.created_at, id: last.id } : null,
    unread_count: Number(count.rows[0]?.count ?? 0),
  };
});

function payloadOf(json: string): { used_bytes: number; quota_bytes: number } {
  try {
    const value: unknown = JSON.parse(json);
    if (
      typeof value === 'object' &&
      value !== null &&
      'used_bytes' in value &&
      'quota_bytes' in value &&
      typeof value.used_bytes === 'number' &&
      Number.isFinite(value.used_bytes) &&
      value.used_bytes >= 0 &&
      typeof value.quota_bytes === 'number' &&
      Number.isFinite(value.quota_bytes) &&
      value.quota_bytes > 0
    ) {
      return { used_bytes: value.used_bytes, quota_bytes: value.quota_bytes };
    }
  } catch {
    /* 以前の形式でも一覧全体を落とさない。 */
  }
  return { used_bytes: 0, quota_bytes: 1 };
}

export const notificationReadOperation = implement(notificationRead, async ({ db, actor, input }) => {
  const userId = actorUserIdOf(actor);
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('notifications')
        .set((eb) => ({ read_at: eb.fn.coalesce('read_at', eb.val(now().toISOString())) }))
        .where('id', '=', input.id)
        .where('user_id', '=', userId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('users')
              .select('id')
              .where('id', '=', userId)
              .where('organization_id', '=', db.organizationId)
              .where('disabled_at', 'is', null),
          ),
        )
        .returning(['id', 'read_at']),
    ),
  ]);
  const row = result.rows[0];
  if (row === undefined || row.read_at === null) throw new ApiError(404, 'not_found');
  return { id: row.id, read_at: row.read_at };
});
