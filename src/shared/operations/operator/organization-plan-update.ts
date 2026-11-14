import { z } from 'zod';
import { billingIntervals, organizationPlans, teamPlans } from '../../organization-plan.ts';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';

// 組織の契約の形。追加容量の口数は口数を変える操作（#1191）までは 0 のまま
export const organizationContract = z.object({
  plan: z.enum(organizationPlans),
  billing_interval: z.enum(billingIntervals),
  extra_10gb_units: z.number().int(),
  extra_50gb_units: z.number().int(),
});

// チーム用の組織の契約（プランと支払いの周期）を書く（docs/data-model.md の「書き込みの単位」の契約の変更）。
// 契約の行を書き、同じ batch() で organizations の人数と添付ファイルの上限を契約から決まる値にし、お試しの期限を空にする
// （有料のプランにしたらお試しを終える）。停止中の組織も書けるが、再開はしない。
// expected は画面が見ていた前の契約（未契約なら null）。今の契約がそれと違えば（確認を開いた後に別の運用者が変えた）409 の conflict。
// 今の契約が送った値と同じなら何も書かず、今の値を返す。自分用の組織は 409 の conflict（reason: personal_organization）、無い slug は 404。
// 解約で消す予定日を過ぎた組織は、消している途中で契約の行を足さないよう 409 の purge_due（境目は再開と同じ）。
// 履歴は action が update で、changes_json はプランと支払いの周期の組と、変わった列（上限、お試しの期限）の前後の値。履歴を書けなくても変更は成功として返す
export const organizationPlanUpdate = defineOperation({
  name: 'organization-plan-update',
  description:
    'チーム用の組織の契約（プランと支払いの周期）を変え、人数と添付ファイルの上限をプランの値にし、お試しを終える。expected は画面が見ていた前の契約（未契約なら null）で、今の契約と違えば 409。消す予定日を過ぎた解約の組織は 409 の purge_due',
  mode: 'write',
  permission: 'operator',
  input: z.object({
    slug: z.string().max(SLUG_MAX_LENGTH * 2),
    plan: z.enum(teamPlans),
    billing_interval: z.enum(billingIntervals),
    expected: z.object({ plan: z.enum(organizationPlans), billing_interval: z.enum(billingIntervals) }).nullable(),
  }),
  output: z.object({
    slug: z.string(),
    contract: organizationContract,
    member_limit: z.number().int(),
    attachment_quota_bytes: z.number().int(),
    trial_ends_on: z.string().nullable(),
  }),
});
