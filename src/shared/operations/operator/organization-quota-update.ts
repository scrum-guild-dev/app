import { z } from 'zod';
import { PLAN_LIMITS } from '../../organization-plan.ts';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 添付ファイルの上限の単位。1 GB = 1024³ バイト（organizations.attachment_quota_bytes の既定 32212254720 が 30 GB）
export const QUOTA_GIB = 1024 ** 3;
// 人数の上限と添付ファイルの上限に入れられる値の範囲。どちらも 1 以上の整数
export const MEMBER_LIMIT_MAX = 10_000;
export const ATTACHMENT_QUOTA_MAX_BYTES = 100 * 1024 ** 4; // 100 TB

// 値段の段階（docs/business.md の「値段の考え方」）。画面の選択肢だけが使い、サーバーは段階を知らずに値を受ける
// （51人以上の組織のために、段階に無い値も入れられるため）
// 値はプランの標準の値（organization-plan.ts の PLAN_LIMITS）と同じ。小さい組織はチーム、標準はビジネス
export const quotaTiers = [
  { id: 'small', ...PLAN_LIMITS.team },
  { id: 'standard', ...PLAN_LIMITS.business },
] as const;

// 409 の conflict の理由。plan_managed は契約のある組織（上限は契約から決まる）
export const quotaUpdateConflictReasons = ['plan_managed'] as const;
export function quotaUpdateConflictReasonOf(details: unknown): (typeof quotaUpdateConflictReasons)[number] | undefined {
  return conflictReasonOf(details, quotaUpdateConflictReasons);
}

const memberLimit = z.number().int().min(1).max(MEMBER_LIMIT_MAX);
const attachmentQuotaBytes = z.number().int().min(1).max(ATTACHMENT_QUOTA_MAX_BYTES);

// 組織の人数の上限と添付ファイルの合計の上限を変える。契約のある組織（organization_contracts に行がある）は、上限を契約から決めるので
// 409 の conflict（reason: plan_managed）で断る。契約は organization-plan-update で変える。停止中の組織も変えられる。人数を今の人数より小さくしてもよい
// （今いる人は残り、招待だけが止まる）。今の値が送った値と同じなら何も書かず、今の値を返す。
// expected は画面が見ていた前の値。今の値がそれと違えば（ダイアログを開いた後に別の運用者が変えた）409 の conflict で、
// 書く文も expected のままであることを条件にする。無い slug は 404。添付ファイルの上限を上げたら
// attachment_quota_warned_at を空に戻す（読んだ値のままであることも条件にする）。履歴は action が update で、
// changes_json は変わった列だけの前後の値。履歴を書けなくても変更は成功として返す
export const organizationQuotaUpdate = defineOperation({
  name: 'organization-quota-update',
  description:
    '組織の人数の上限と添付ファイルの合計の上限（バイト）を変える。expected は画面が見ていた前の値で、今の値と違えば 409。契約のある組織は 409 の plan_managed',
  mode: 'write',
  permission: 'operator',
  input: z.object({
    slug: z.string().max(SLUG_MAX_LENGTH * 2),
    member_limit: memberLimit,
    attachment_quota_bytes: attachmentQuotaBytes,
    expected: z.object({ member_limit: memberLimit, attachment_quota_bytes: attachmentQuotaBytes }),
  }),
  output: z.object({
    slug: z.string(),
    member_limit: z.number().int(),
    attachment_quota_bytes: z.number().int(),
  }),
});
