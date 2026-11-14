// 組織の契約（organization_contracts）のプラン、支払いの周期、追加容量と、契約から決まる人数と添付ファイルの上限。
// 値は docs/business.md の「基本プラン」「追加容量」。DB の列挙（organization_contracts.plan と billing_interval）と同じ値を持つ
const GIB = 1024 ** 3;

// custom は51人以上の個別の契約。DB の CHECK には先に入れてあるが、書くのは後の版（#1192）。上限の導き方もそのときに足す
export const organizationPlans = ['personal', 'team', 'business', 'custom'] as const;
export type OrganizationPlan = (typeof organizationPlans)[number];

// チーム用の組織が選べるプラン。自分用の組織（kind が personal）はパーソナルに固定で、運用者はプランを選ばない
export const teamPlans = ['team', 'business'] as const;
export type TeamPlan = (typeof teamPlans)[number];

export const billingIntervals = ['monthly', 'yearly'] as const;
export type BillingInterval = (typeof billingIntervals)[number];

// プランごとの標準の人数と添付ファイルの容量（バイト）。ワークスペースの個数の上限は種類で決める（organization-kind.ts の WORKSPACE_LIMITS）
export const PLAN_LIMITS = {
  personal: { member_limit: 1, attachment_quota_bytes: 1 * GIB },
  team: { member_limit: 15, attachment_quota_bytes: 30 * GIB },
  business: { member_limit: 50, attachment_quota_bytes: 100 * GIB },
} as const satisfies Record<
  Exclude<OrganizationPlan, 'custom'>,
  { member_limit: number; attachment_quota_bytes: number }
>;

// 追加容量の1口あたりの容量（バイト）
export const EXTRA_10GB_BYTES = 10 * GIB;
export const EXTRA_50GB_BYTES = 50 * GIB;

export type ContractLimitsInput = {
  plan: Exclude<OrganizationPlan, 'custom'>;
  extra_10gb_units: number;
  extra_50gb_units: number;
};

// 契約から決まる人数と添付ファイルの上限。添付ファイルは、プランの標準の容量に追加容量の口数を足す。
// 運用者が契約を書くときに organizations.member_limit と attachment_quota_bytes へ写す（docs/data-model.md の organization_contracts）
export function contractLimits(contract: ContractLimitsInput): {
  member_limit: number;
  attachment_quota_bytes: number;
} {
  const base = PLAN_LIMITS[contract.plan];
  return {
    member_limit: base.member_limit,
    attachment_quota_bytes:
      base.attachment_quota_bytes +
      contract.extra_10gb_units * EXTRA_10GB_BYTES +
      contract.extra_50gb_units * EXTRA_50GB_BYTES,
  };
}
