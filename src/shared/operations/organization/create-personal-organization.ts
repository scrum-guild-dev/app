import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 409 の conflict で断った理由。slug_taken は同じ slug の組織がある、personal_limit はこのアカウントが既に自分用を持つ
export const createPersonalOrganizationConflictReasons = ['slug_taken', 'personal_limit'] as const;
export type CreatePersonalOrganizationConflictReason = (typeof createPersonalOrganizationConflictReasons)[number];

export function createPersonalOrganizationConflictReasonOf(
  details: unknown,
): CreatePersonalOrganizationConflictReason | undefined {
  return conflictReasonOf(details, createPersonalOrganizationConflictReasons);
}

// 組織に入らずに、1人だけの自分用の組織を作り、その管理者になる（実装は別）
export const createPersonalOrganization = defineOperation({
  name: 'create-personal-organization',
  description: '自分用の組織を作り、その管理者になる。1アカウントに1つだけ。slug は後から変えられない',
  mode: 'write',
  permission: 'login',
  rateLimit: { max: 30, windowSeconds: 600 },
  cookieOnly: true,
  input: z.object({ slug: z.string().max(SLUG_MAX_LENGTH * 2) }),
  output: z.object({ slug: z.string(), name: z.string() }),
});
