// 未添付で1日を過ぎた行を D1 から先に消し、実際に消したキーだけを R2 から消す。
// 保存が先に付けた行は DELETE の条件から外れる。R2 の失敗は行を戻さず、件数だけを記録する。
import { commonDb, deleteExpiredAttachments } from '../db/index.ts';

export const ATTACHMENT_CLEANUP_ROW_LIMIT = 50;
export const ATTACHMENT_CLEANUP_MAX_ROUNDS = 20;
export const ATTACHMENT_CLEANUP_TIME_BUDGET_MS = 20_000;
// 空振りと失敗も数え、組織が多くても D1 と R2 の呼び出し回数を有限にする。
export const ATTACHMENT_CLEANUP_MAX_TOTAL_ROUNDS = 200;
const ORGANIZATION_PAGE_SIZE = 50;
const JOB = 'cleanup-attachments';
// アップロードのキー（先頭が UUID の組織 ID）と重ならない内部の進捗。ファイルの中身は入れない。
const CURSOR_KEY = 'system/cleanup-attachments-cursor';

export type CleanupAttachmentsOptions = {
  limit?: number;
  maxRounds?: number;
  timeBudgetMs?: number;
};

export async function cleanupAttachments(
  env: Env,
  scheduledTime: Date,
  options: CleanupAttachmentsOptions = {},
): Promise<void> {
  const {
    limit = ATTACHMENT_CLEANUP_ROW_LIMIT,
    maxRounds = ATTACHMENT_CLEANUP_MAX_ROUNDS,
    timeBudgetMs = ATTACHMENT_CLEANUP_TIME_BUDGET_MS,
  } = options;
  // テストは予算を小さくできる。本番の上限を超える値と、無制限になりうる値は受けない。
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > ATTACHMENT_CLEANUP_ROW_LIMIT ||
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > ATTACHMENT_CLEANUP_MAX_ROUNDS ||
    !Number.isFinite(timeBudgetMs) ||
    timeBudgetMs < 0 ||
    timeBudgetMs > ATTACHMENT_CLEANUP_TIME_BUDGET_MS
  )
    throw new Error('添付ファイルの掃除の予算が範囲外');

  const startedAt = Date.now();
  const cutoff = new Date(scheduledTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const common = commonDb(env);
  let after: string;
  try {
    const cursor = await env.ATTACHMENTS.get(CURSOR_KEY);
    // ID は最大64字。壊れた進捗は先頭からやり直す（SQL には束縛して渡す）。
    after = cursor === null || cursor.size > 64 ? '' : await cursor.text();
  } catch (error) {
    logFailure('掃除の進捗を読めなかった', 1, error);
    throw new Error('未添付のファイルの掃除の進捗を読めなかった', { cause: error });
  }
  let rounds = 0;
  let deleted = 0;
  let failures = 0;
  let limited = false;
  let complete = false;
  const hasBudget = () => rounds < ATTACHMENT_CLEANUP_MAX_TOTAL_ROUNDS && Date.now() - startedAt < timeBudgetMs;

  while (hasBudget()) {
    let organizations: { id: string }[];
    try {
      organizations = await common.rows(
        common.statement((q) =>
          q
            .selectFrom('organizations')
            .select('id')
            .where('suspended_at', 'is', null)
            .where('id', '>', after)
            .orderBy('id')
            .limit(ORGANIZATION_PAGE_SIZE),
        ),
      );
    } catch (error) {
      failures++;
      logFailure('組織の一覧を読めなかった', 1, error);
      break;
    }
    for (const organization of organizations) {
      if (!hasBudget()) break;
      after = organization.id;
      for (let round = 0; round < maxRounds && hasBudget(); round++) {
        rounds++;
        let keys: readonly string[];
        try {
          keys = await deleteExpiredAttachments(env, organization.id, cutoff, limit);
        } catch (error) {
          failures++;
          logFailure('未添付の行を消せなかった', 1, error);
          break;
        }
        deleted += keys.length;
        const safeKeys = keys.filter((key) => key.startsWith(`${organization.id}/`));
        if (safeKeys.length !== keys.length) {
          logFailure('組織の ID で始まらないキーは消さなかった', keys.length - safeKeys.length);
        }
        try {
          // 時間切れでも、既に消した行のファイルは必ず削除を試み、完了を待つ。
          if (safeKeys.length > 0) await env.ATTACHMENTS.delete(safeKeys);
        } catch (error) {
          failures++;
          logFailure('R2 のファイルを消せなかった', safeKeys.length, error);
          break;
        }
        if (keys.length < limit) break;
        if (round + 1 === maxRounds) limited = true;
      }
    }
    if (hasBudget() && organizations.length < ORGANIZATION_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  limited ||= !hasBudget();
  try {
    // 全組織を見終えたら先頭へ戻る。上限で止まった回は、次回に後ろの組織から続ける。
    // 同時実行で進捗が戻っても DELETE が条件を確かめ直すため、付いた行や別の組織は消さない。
    await env.ATTACHMENTS.put(CURSOR_KEY, complete ? '' : after);
  } catch (error) {
    failures++;
    logFailure('掃除の進捗を保存できなかった', 1, error);
  }
  if (deleted > 0 || limited) {
    const line = JSON.stringify({ level: limited ? 'warn' : 'info', job: JOB, deleted, rounds, limited });
    if (limited) console.warn(line);
    else console.info(line);
  }
  if (failures > 0) throw new Error('未添付のファイルの掃除に失敗した');
}
function logFailure(reason: string, count: number, error?: unknown): void {
  // キー、例外の message、SQL と束縛する値は出さない。
  console.error(
    JSON.stringify({
      level: 'error',
      code: 'internal',
      job: JOB,
      reason,
      count,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.name : typeof error }),
    }),
  );
}
