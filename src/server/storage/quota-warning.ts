import { reconcileAttachmentQuotaWarning, type QuotaWarningOptions } from '../db/index.ts';
import { now } from '../../shared/clock.ts';

type RunningCheck = { again: boolean; done: Promise<void> };
const runningChecks = new Map<string, RunningCheck>();

// 保存後の副作用だけを同じisolate・組織で合流する。認可や容量の厳密な書き込み条件は各リクエストで行う。
// 実行中に新しい保存があれば一度だけ追随する。追随中の追加保存は世代CASでdirtyを残し、cronへ渡す。
// 完了後はMapから消すので、容量の値や権限をキャッシュせず、書き込みをロックするものでもない。
export function reconcileAttachmentQuotaAfterSave(env: Env, organizationId: string): Promise<void> {
  const existing = runningChecks.get(organizationId);
  if (existing !== undefined) {
    existing.again = true;
    return existing.done;
  }
  const running: RunningCheck = { again: false, done: Promise.resolve() };
  runningChecks.set(organizationId, running);
  running.done = (async () => {
    try {
      await reconcileAttachmentQuota(env, organizationId, now());
      if (running.again) {
        running.again = false;
        await reconcileAttachmentQuota(env, organizationId, now());
      }
    } finally {
      if (runningChecks.get(organizationId) === running) runningChecks.delete(organizationId);
    }
  })();
  return running.done;
}

export async function reconcileAttachmentQuota(
  env: Env,
  organizationId: string,
  at: Date,
  options: QuotaWarningOptions = {},
): Promise<void> {
  await reconcileAttachmentQuotaWarning(env, organizationId, at, options);
}
