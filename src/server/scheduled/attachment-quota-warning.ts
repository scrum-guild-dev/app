import { cleanupReadNotifications, commonDb } from '../db/index.ts';
import { reconcileAttachmentQuota } from '../storage/quota-warning.ts';

const CURSOR_KEY = 'system/attachment-quota-warning-cursor';
const CLEANUP_CURSOR_KEY = 'system/notification-cleanup-cursor';
const MAX_ORGANIZATIONS = 10;
const MAX_NOTIFICATION_BATCHES = 5;
const TIME_BUDGET_MS = 20_000;

// 容量を読むのは通知済み・配信待ち・変更待ちだけ。10組織×5配信batch（各50人を1文）の上限でD1呼出を制限する。
// 既読通知の保持期限の掃除は別のcursorで全組織を10件ずつ回り、容量を集計しない。
export async function attachmentQuotaWarningJob(env: Env, at: Date): Promise<void> {
  const startedAt = Date.now();
  const common = commonDb(env);
  let failures = 0;
  const cutoff = new Date(at.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  for (const cleanup of [false, true]) {
    const key = cleanup ? CLEANUP_CURSOR_KEY : CURSOR_KEY;
    const stored = await env.ATTACHMENTS.get(key);
    const after = stored === null || stored.size > 64 ? '' : await stored.text();
    const organizations = await common.rows(
      common.statement((q) => {
        let query = q
          .selectFrom('organizations')
          .select('id')
          .where('suspended_at', 'is', null)
          .where('id', '>', after);
        if (!cleanup)
          query = query.where((eb) =>
            eb.or([
              eb('attachment_quota_warned_at', 'is not', null),
              eb('attachment_quota_warning_pending_at', 'is not', null),
              eb('attachment_quota_check_pending_at', 'is not', null),
            ]),
          );
        return query.orderBy('id').limit(MAX_ORGANIZATIONS);
      }),
    );
    let last = after;
    let processed = 0;
    for (const organization of organizations) {
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
      last = organization.id;
      processed++;
      try {
        if (cleanup) await cleanupReadNotifications(env, organization.id, cutoff, 1000);
        else
          await reconcileAttachmentQuota(env, organization.id, at, {
            maxNotificationBatches: MAX_NOTIFICATION_BATCHES,
          });
      } catch (error) {
        failures++;
        console.error(
          JSON.stringify({
            level: 'error',
            code: 'internal',
            job: 'attachment-quota-warning',
            error: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
    }
    const complete = processed === organizations.length && organizations.length < MAX_ORGANIZATIONS;
    await env.ATTACHMENTS.put(key, complete ? '' : last);
  }
  if (failures > 0) throw new Error('容量の通知の定期処理に失敗した');
}
