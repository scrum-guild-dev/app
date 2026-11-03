// 定期処理が共通の表から読んだ、停止していない組織の ID だけを渡す。
// 組織の入口は外へ出さず、期限を過ぎた未添付の行を消し、実際に消したキーだけを返す。
import { orgDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';

export async function deleteExpiredAttachments(
  env: Env,
  organizationId: string,
  cutoff: string,
  limit: number,
): Promise<readonly string[]> {
  const db = orgDb(env, issueVerifiedOrganization(organizationId));
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .deleteFrom('attachments')
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', db.organizationId),
        )
        .where('attached_at', 'is', null)
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('attachments')
            .select('id')
            .where('workspace_id', 'in', (eb) =>
              eb.selectFrom('workspaces').select('id').where('organization_id', '=', db.organizationId),
            )
            .where('attached_at', 'is', null)
            .where('created_at', '<', cutoff)
            .limit(limit),
        )
        .returning('object_key'),
    ),
  ]);
  return result.rows.map((row) => row.object_key);
}
