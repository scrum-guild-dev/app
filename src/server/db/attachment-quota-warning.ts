import { commonDb, orgDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';
import { organizationStorageBytes } from './wiki.ts';

// 共通の組織の行を先に読み、停止していないことを確かめてから組織の入口を作る。
// 二つの DB の書き込みは混ぜない。pending を残すことで、通知の保存失敗は次の定期処理で再試行できる。
export async function reconcileAttachmentQuotaWarning(env: Env, organizationId: string, at: Date): Promise<void> {
  const common = commonDb(env);
  const current = await common.first(
    common.statement((q) =>
      q
        .selectFrom('organizations')
        .select(['attachment_quota_bytes', 'attachment_quota_warned_at', 'attachment_quota_warning_pending_at'])
        .where('id', '=', organizationId)
        .where('suspended_at', 'is', null),
    ),
  );
  if (current === undefined) return;
  const db = orgDb(env, issueVerifiedOrganization(organizationId));
  const total = await db.first(db.statement((q) => q.selectNoFrom(organizationStorageBytes(db).as('bytes'))));
  const bytes = Number(total?.bytes ?? 0);
  const quota = current.attachment_quota_bytes;
  if (bytes * 5 < quota * 4) {
    await common.batch([
      common.statement((q) => {
        let update = q
          .updateTable('organizations')
          .set({ attachment_quota_warned_at: null, attachment_quota_warning_pending_at: null })
          .where('id', '=', organizationId)
          .where('suspended_at', 'is', null)
          .where('attachment_quota_bytes', '=', quota);
        update =
          current.attachment_quota_warned_at === null
            ? update.where('attachment_quota_warned_at', 'is', null)
            : update.where('attachment_quota_warned_at', '=', current.attachment_quota_warned_at);
        return update;
      }),
    ]);
    return;
  }
  let cycle = current.attachment_quota_warning_pending_at;
  if (cycle === null) {
    if (bytes * 5 <= quota * 4 || current.attachment_quota_warned_at !== null) return;
    // 開発用の時計が固定でも、80%未満→再超過を別の通知として扱う。
    const previous = await db.first(
      db.statement((q) =>
        q
          .selectFrom('notifications as n')
          .innerJoin('users as recipient', 'recipient.id', 'n.user_id')
          .select((eb) => eb.fn.max('n.created_at').as('at'))
          .where('recipient.organization_id', '=', organizationId)
          .where('n.kind', '=', 'attachment_quota_warning'),
      ),
    );
    cycle = new Date(Math.max(at.getTime(), previous?.at == null ? 0 : Date.parse(previous.at) + 1)).toISOString();
    const [claimed] = await common.batch([
      common.statement((q) =>
        q
          .updateTable('organizations')
          .set({ attachment_quota_warned_at: cycle, attachment_quota_warning_pending_at: cycle })
          .where('id', '=', organizationId)
          .where('suspended_at', 'is', null)
          .where('attachment_quota_bytes', '=', quota)
          .where('attachment_quota_warned_at', 'is', null)
          .where('attachment_quota_warning_pending_at', 'is', null),
      ),
    ]);
    if (claimed.changes === 0) return;
  }
  // 共通と組織の DB は別のトランザクションなので、確保後の停止・上限変更・取消を、
  // 配信の各 batch の直前に確かめ直す。この SELECT と組織 DB の INSERT は原子的ではない。
  const claimIsCurrent = async () =>
    (await common.first(
      common.statement((q) =>
        q
          .selectFrom('organizations')
          .select('id')
          .where('id', '=', organizationId)
          .where('suspended_at', 'is', null)
          .where('attachment_quota_bytes', '=', quota)
          .where('attachment_quota_warned_at', '=', cycle)
          .where('attachment_quota_warning_pending_at', '=', cycle),
      ),
    )) !== undefined;
  if (!(await claimIsCurrent())) return;
  const admins = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('is_admin', '=', 1)
        .where('disabled_at', 'is', null),
    ),
  );
  // 各 INSERT も、読んだ後の無効化と管理者解除を条件にする。再試行で同じ ID を使い、既読も上書きしない。
  for (let offset = 0; offset < admins.length; offset += 50) {
    const rows = await Promise.all(
      admins.slice(offset, offset + 50).map(async (admin) => ({
        userId: admin.id,
        id: await warningId(organizationId, admin.id, cycle),
      })),
    );
    if (!(await claimIsCurrent())) return;
    await db.batch(
      rows.map((row) =>
        db.statement((q) =>
          q
            .insertInto('notifications')
            .columns(['id', 'user_id', 'kind', 'payload_json', 'created_at'])
            .expression((eb) =>
              eb
                .selectFrom('users')
                .select([
                  eb.val(row.id).as('id'),
                  'id as user_id',
                  eb.val('attachment_quota_warning').as('kind'),
                  eb.val(JSON.stringify({ used_bytes: bytes, quota_bytes: quota })).as('payload_json'),
                  eb.val(cycle).as('created_at'),
                ])
                .where('id', '=', row.userId)
                .where('organization_id', '=', organizationId)
                .where('is_admin', '=', 1)
                .where('disabled_at', 'is', null),
            )
            .onConflict((oc) => oc.column('id').doNothing()),
        ),
      ),
    );
  }
  await common.batch([
    common.statement((q) =>
      q
        .updateTable('organizations')
        .set({ attachment_quota_warning_pending_at: null })
        .where('id', '=', organizationId)
        .where('suspended_at', 'is', null)
        .where('attachment_quota_bytes', '=', quota)
        .where('attachment_quota_warned_at', '=', cycle)
        .where('attachment_quota_warning_pending_at', '=', cycle),
    ),
  ]);
}

// UUIDv7 の時刻部を通知の確保日時にし、乱数部を受信者と確保日時から決める。
async function warningId(organizationId: string, userId: string, cycle: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${organizationId}:${userId}:${cycle}`)),
  );
  const bytes = digest.slice(0, 16);
  let time = Date.parse(cycle);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function cleanupReadNotifications(
  env: Env,
  organizationId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const db = orgDb(env, issueVerifiedOrganization(organizationId));
  const [deleted] = await db.batch([
    db.statement((q) =>
      q
        .deleteFrom('notifications')
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('notifications as n')
            .innerJoin('users as recipient', 'recipient.id', 'n.user_id')
            .select('n.id')
            .where('recipient.organization_id', '=', organizationId)
            .where('n.read_at', '<', cutoff)
            .orderBy('n.read_at')
            .limit(limit),
        ),
    ),
  ]);
  return deleted.changes;
}
