import { reconcileAttachmentQuotaWarning } from '../db/index.ts';

export async function reconcileAttachmentQuota(env: Env, organizationId: string, at: Date): Promise<void> {
  await reconcileAttachmentQuotaWarning(env, organizationId, at);
}
