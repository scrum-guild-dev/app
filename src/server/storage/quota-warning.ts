import { reconcileAttachmentQuotaWarning, type QuotaWarningOptions } from '../db/index.ts';

export async function reconcileAttachmentQuota(
  env: Env,
  organizationId: string,
  at: Date,
  options: QuotaWarningOptions = {},
): Promise<void> {
  await reconcileAttachmentQuotaWarning(env, organizationId, at, options);
}
