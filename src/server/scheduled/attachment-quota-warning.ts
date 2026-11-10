import { cleanupReadNotifications, commonDb } from '../db/index.ts';
import { reconcileAttachmentQuota } from '../storage/quota-warning.ts';

const CURSOR_KEY = 'system/attachment-quota-warning-cursor';
const MAX_ORGANIZATIONS = 200;
const TIME_BUDGET_MS = 20_000;

// 毎分、削除後の容量と未完了の通知を確かめる。予算で止まったら次の組織から続け、末尾で先頭に戻る。
export async function attachmentQuotaWarningJob(env: Env, at: Date): Promise<void> {
  const startedAt = Date.now();
  const stored = await env.ATTACHMENTS.get(CURSOR_KEY);
  let after = stored === null || stored.size > 64 ? '' : await stored.text();
  const common = commonDb(env);
  const cutoff = new Date(at.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  let count = 0;
  let complete = false;
  let failures = 0;
  while (count < MAX_ORGANIZATIONS && Date.now() - startedAt < TIME_BUDGET_MS) {
    const organizations = await common.rows(
      common.statement((q) =>
        q
          .selectFrom('organizations')
          .select('id')
          .where('suspended_at', 'is', null)
          .where('id', '>', after)
          .orderBy('id')
          .limit(25),
      ),
    );
    if (organizations.length === 0) {
      complete = true;
      break;
    }
    for (const organization of organizations) {
      if (count >= MAX_ORGANIZATIONS || Date.now() - startedAt >= TIME_BUDGET_MS) break;
      after = organization.id;
      count++;
      try {
        await cleanupReadNotifications(env, organization.id, cutoff, 1000);
        await reconcileAttachmentQuota(env, organization.id, at);
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
    if (organizations.length < 25 && count < MAX_ORGANIZATIONS && Date.now() - startedAt < TIME_BUDGET_MS) {
      complete = true;
      break;
    }
  }
  await env.ATTACHMENTS.put(CURSOR_KEY, complete ? '' : after);
  if (failures > 0) throw new Error('容量の通知の定期処理に失敗した');
}
