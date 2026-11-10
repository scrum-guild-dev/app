import { sql } from 'kysely';
import { commonDb, orgDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';
import { organizationStorageBytes } from './wiki.ts';
import { jsonPairRows } from './json-list.ts';

export type QuotaWarningOptions = { maxNotificationBatches?: number };
const NOTIFICATION_BATCH_SIZE = 50;
const MAX_NOTIFICATION_BATCHES = 5;

// 保存後は安価な共通行の更新だけ待つ。固定時計や同時の保存でも、後続の変更を古い確認が消さないよう単調にする。
export async function markAttachmentQuotaCheck(env: Env, organizationId: string, at: Date): Promise<boolean> {
  const common = commonDb(env);
  const value = at.toISOString();
  const [updated] = await common.batch([
    common.statement((q) =>
      q
        .updateTable('organizations')
        .set({
          attachment_quota_check_pending_at: sql<string>`case when attachment_quota_check_pending_at >= ${value}
      then strftime('%Y-%m-%dT%H:%M:%fZ', attachment_quota_check_pending_at, '+0.001 seconds') else ${value} end`,
        })
        .where('id', '=', organizationId)
        .where('suspended_at', 'is', null),
    ),
  ]);
  return updated.changes > 0;
}

// 共通と組織の DB の書き込みは混ぜない。未完了の周期と変更待ちを残し、予算で止まった配信を次回へ渡す。
export async function reconcileAttachmentQuotaWarning(
  env: Env,
  organizationId: string,
  at: Date,
  options: QuotaWarningOptions = {},
): Promise<void> {
  const maxBatches = options.maxNotificationBatches ?? MAX_NOTIFICATION_BATCHES;
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_NOTIFICATION_BATCHES)
    throw new Error('容量通知の配信予算が範囲外');
  const common = commonDb(env);
  const current = await common.first(
    common.statement((q) =>
      q
        .selectFrom('organizations')
        .select([
          'attachment_quota_bytes',
          'attachment_quota_warned_at',
          'attachment_quota_warning_pending_at',
          'attachment_quota_check_pending_at',
        ])
        .where('id', '=', organizationId)
        .where('suspended_at', 'is', null),
    ),
  );
  if (current === undefined) return;
  const db = orgDb(env, issueVerifiedOrganization(organizationId));
  const total = await db.first(db.statement((q) => q.selectNoFrom(organizationStorageBytes(db).as('bytes'))));
  const bytes = Number(total?.bytes ?? 0);
  const quota = current.attachment_quota_bytes;
  const clearDirty = async () => {
    if (current.attachment_quota_check_pending_at === null) return;
    await common.batch([
      common.statement((q) =>
        q
          .updateTable('organizations')
          .set({ attachment_quota_check_pending_at: null })
          .where('id', '=', organizationId)
          .where('suspended_at', 'is', null)
          .where('attachment_quota_bytes', '=', quota)
          .where('attachment_quota_check_pending_at', '=', current.attachment_quota_check_pending_at),
      ),
    ]);
  };
  if (bytes * 5 < quota * 4) {
    if (
      current.attachment_quota_warned_at === null &&
      current.attachment_quota_warning_pending_at === null &&
      current.attachment_quota_check_pending_at === null
    )
      return;
    await common.batch([
      common.statement((q) => {
        let update = q
          .updateTable('organizations')
          .set({
            attachment_quota_warned_at: null,
            attachment_quota_warning_pending_at: null,
            attachment_quota_check_pending_at: null,
          })
          .where('id', '=', organizationId)
          .where('suspended_at', 'is', null)
          .where('attachment_quota_bytes', '=', quota);
        update =
          current.attachment_quota_warned_at === null
            ? update.where('attachment_quota_warned_at', 'is', null)
            : update.where('attachment_quota_warned_at', '=', current.attachment_quota_warned_at);
        update =
          current.attachment_quota_warning_pending_at === null
            ? update.where('attachment_quota_warning_pending_at', 'is', null)
            : update.where('attachment_quota_warning_pending_at', '=', current.attachment_quota_warning_pending_at);
        update =
          current.attachment_quota_check_pending_at === null
            ? update.where('attachment_quota_check_pending_at', 'is', null)
            : update.where('attachment_quota_check_pending_at', '=', current.attachment_quota_check_pending_at);
        return update;
      }),
    ]);
    return;
  }
  let cycle = current.attachment_quota_warning_pending_at;
  if (cycle === null) {
    if (bytes * 5 <= quota * 4 || current.attachment_quota_warned_at !== null) {
      await clearDirty();
      return;
    }
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
  // この SELECT と組織 DB の INSERT は別トランザクションであり、原子的ではない。
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
  const recipients = () =>
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('is_admin', '=', 1)
        .where('disabled_at', 'is', null)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('notifications as sent')
                .select('sent.id')
                .whereRef('sent.user_id', '=', 'users.id')
                .where('sent.kind', '=', 'attachment_quota_warning')
                .where('sent.created_at', '=', cycle),
            ),
          ),
        )
        .orderBy('id')
        .limit(NOTIFICATION_BATCH_SIZE),
    );
  let complete = false;
  for (let batch = 0; batch < maxBatches; batch++) {
    const admins = await db.rows(recipients());
    if (admins.length === 0) {
      complete = true;
      break;
    }
    const pairs = await Promise.all(
      admins.map(async (admin): Promise<readonly [string, string]> => [
        admin.id,
        await warningId(organizationId, admin.id, cycle),
      ]),
    );
    if (!(await claimIsCurrent())) return;
    // 50人を1文で書き、D1の呼出数を制限する。受信者の権限は書く文でも再検査する。
    await db.batch([
      db.statement((q) =>
        q
          .insertInto('notifications')
          .columns(['id', 'user_id', 'kind', 'payload_json', 'created_at'])
          .expression((eb) =>
            eb
              .selectFrom(jsonPairRows(pairs).as('candidate'))
              .innerJoin('users', 'users.id', 'candidate.id')
              .select([
                'candidate.pos as id',
                'users.id as user_id',
                eb.val('attachment_quota_warning').as('kind'),
                eb.val(JSON.stringify({ used_bytes: bytes, quota_bytes: quota })).as('payload_json'),
                eb.val(cycle).as('created_at'),
              ])
              .where('users.organization_id', '=', organizationId)
              .where('users.is_admin', '=', 1)
              .where('users.disabled_at', 'is', null),
          )
          .onConflict((oc) => oc.column('id').doNothing()),
      ),
    ]);
  }
  if (!complete) complete = (await db.rows(recipients())).length === 0;
  if (!complete) return;
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
  await clearDirty();
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
