// 定期処理の表。wrangler.jsonc の triggers.crons の式から処理を引く。表に無い式で起きたら、設定の食い違いなので例外にする
import { attachmentQuotaWarningJob } from './attachment-quota-warning.ts';
import { cleanupWiki } from './cleanup-wiki.ts';
import { cleanupAttachments } from './cleanup-attachments.ts';
import { cleanupApiTokens } from './cleanup-api-tokens.ts';
import { cleanupExpired } from './cleanup-expired.ts';
import { suspendExpiredTrialsJob } from './suspend-expired-trials.ts';

type ScheduledJob = (env: Env, scheduledTime: Date) => Promise<void>;

// 1つが失敗しても残りを実行する。最初の失敗を、全部を終えてから投げる（cron の失敗として残る）
async function runJobs(jobs: readonly ScheduledJob[], env: Env, scheduledTime: Date): Promise<void> {
  const failures: unknown[] = [];
  for (const job of jobs) {
    try {
      await job(env, scheduledTime);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}

const minuteJobs: readonly ScheduledJob[] = [cleanupExpired, cleanupApiTokens, cleanupWiki, attachmentQuotaWarningJob];

const scheduledJobs: ReadonlyMap<string, ScheduledJob> = new Map<string, ScheduledJob>([
  // 毎分: 期限を過ぎた行を消す（oauth_states、sessions、rate_limits と、api_tokens）
  ['* * * * *', (env, at) => runJobs(minuteJobs, env, at)],
  // 毎時 0 分: お試しの期限切れを止め、停止していない組織の未添付のファイルを消す
  ['0 * * * *', (env, at) => runJobs([suspendExpiredTrialsJob, cleanupAttachments], env, at)],
]);

export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const job = scheduledJobs.get(controller.cron);
  if (job === undefined) throw new Error(`定期処理の表に無い cron の式: ${controller.cron}`);
  await job(env, new Date(controller.scheduledTime));
}
