// 組織の契約（共通の表の organization_contracts）の行を、応答の形にする。行が無い組織（左結合で列が空）は null
import type { BillingInterval, OrganizationPlan } from '../../shared/organization-plan.ts';

export type ContractRow = {
  plan: string | null;
  billing_interval: string | null;
  extra_10gb_units: number | null;
  extra_50gb_units: number | null;
};

export type Contract = {
  plan: OrganizationPlan;
  billing_interval: BillingInterval;
  extra_10gb_units: number;
  extra_50gb_units: number;
};

export function contractOf(row: ContractRow): Contract | null {
  if (row.plan === null || row.billing_interval === null) return null;
  return {
    // 列の CHECK が守る値
    plan: row.plan as OrganizationPlan,
    billing_interval: row.billing_interval as BillingInterval,
    extra_10gb_units: row.extra_10gb_units ?? 0,
    extra_50gb_units: row.extra_50gb_units ?? 0,
  };
}
