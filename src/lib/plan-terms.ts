// 組織の契約（プランと支払いの周期）の表示の文。運用の画面と組織の変更の履歴が使う。
// translate は t（か、テストが言葉を決めた word）
import type { BillingInterval, OrganizationPlan } from '../shared/organization-plan.ts';
import type { DictionaryKey, TemplateParams } from '../shared/vocabulary.ts';

type Translate = (key: DictionaryKey, params?: TemplateParams) => string;

const PLAN_KEYS = {
  personal: 'planPersonal',
  team: 'planTeam',
  business: 'planBusiness',
  custom: 'planCustom',
} as const satisfies Record<OrganizationPlan, DictionaryKey>;
const INTERVAL_KEYS = {
  monthly: 'billingMonthly',
  yearly: 'billingYearly',
} as const satisfies Record<BillingInterval, DictionaryKey>;

// 契約（プランと支払いの周期）の表示。「チーム・月払い」の形
export function planTermsText(
  terms: { plan: OrganizationPlan; billing_interval: BillingInterval },
  translate: Translate,
): string {
  return translate('planTerms', {
    plan: translate(PLAN_KEYS[terms.plan]),
    interval: translate(INTERVAL_KEYS[terms.billing_interval]),
  });
}

// 運用の画面の契約の印。契約があれば「チーム・月払い」の形、無ければ自分用は「パーソナル」、チーム用は「未契約」
export function planLabel(
  organization: {
    kind: 'team' | 'personal';
    contract: { plan: OrganizationPlan; billing_interval: BillingInterval } | null;
  },
  translate: Translate,
): string {
  if (organization.contract !== null) return planTermsText(organization.contract, translate);
  return translate(organization.kind === 'personal' ? 'planPersonal' : 'operatorPlanNone');
}
