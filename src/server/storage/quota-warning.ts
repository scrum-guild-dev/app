import { reconcileAttachmentQuotaWarning, type QuotaWarningOptions } from '../db/index.ts';
import { now } from '../../shared/clock.ts';

type RunningCheck = { again: boolean; startedAt: number };
const runningChecks = new Map<string, RunningCheck>();
const AFTER_SAVE_CHECK_TTL_MS = 30_000;

// 保存後の副作用だけを同じisolate・組織で合流する。認可や容量の厳密な書き込み条件は各リクエストで行う。
// 実行中に新しい保存があれば一度だけ追随する。追随中の追加保存は世代CASでdirtyを残し、cronへ渡す。
// 共有するのは実行中の印だけ。別リクエストはownerのI/O Promiseを保持せず、その完了も待たない。
// ownerが中断してfinallyまで届かなくても、waitUntilの猶予に合わせ実時間30秒で置き換える。
// 業務の固定時計now()では期限が進まないためDate.now()を使う。旧処理が生きていれば新処理と並走しうる。
// 後続が追随に間に合わなくても登録済みdirtyはcronが拾う。容量や権限のキャッシュ・書込ロックではない。
export function reconcileAttachmentQuotaAfterSave(env: Env, organizationId: string): Promise<void> {
  const startedAt = Date.now();
  const existing = runningChecks.get(organizationId);
  if (existing !== undefined && startedAt - existing.startedAt < AFTER_SAVE_CHECK_TTL_MS) {
    existing.again = true;
    return Promise.resolve();
  }
  const running: RunningCheck = { again: false, startedAt };
  runningChecks.set(organizationId, running);
  return (async () => {
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
}

export async function reconcileAttachmentQuota(
  env: Env,
  organizationId: string,
  at: Date,
  options: QuotaWarningOptions = {},
): Promise<void> {
  await reconcileAttachmentQuotaWarning(env, organizationId, at, options);
}
