import { PLAN_LIMITS } from './organization-plan.ts';

// 組織の種類。DB の列挙（organizations.kind）と同じ値。team はチーム用、personal は1人だけの自分用
export const organizationKinds = ['team', 'personal'] as const;
export type OrganizationKind = (typeof organizationKinds)[number];

// 自分用の組織の名前。組織を作るときに固定で入れ、画面は kind が personal の組織をこの名前の辞書の語で出す。
// 値は辞書の personalOrganizationName と同じにする（別々に定義しているので、src/lib/organization-label.test.ts が同じ値であることを縛る）
export const PERSONAL_ORGANIZATION_NAME = '自分用';

// 自分用の組織の添付ファイルの上限（バイト）。1GB。パーソナルのプランの標準の容量
export const PERSONAL_ATTACHMENT_QUOTA_BYTES = PLAN_LIMITS.personal.attachment_quota_bytes;

// 種類ごとのワークスペースの個数の上限（利用中だけを数える）。null は無制限。
// 自分用は無料なので3個まで（将来のプランで増やす）
export const WORKSPACE_LIMITS: Record<OrganizationKind, number | null> = {
  personal: 3,
  team: null,
};
