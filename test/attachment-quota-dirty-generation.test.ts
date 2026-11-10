import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, markAttachmentQuotaCheck, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { attachmentQuotaWarningJob } from '../src/server/scheduled/attachment-quota-warning.ts';
import { createAttachment, createOrganization, createUser, createWorkspace } from './factories.ts';

const at = new Date('2026-11-10T08:00:00.000Z');

describe('容量警告のレビュー修正への独立反証 第2巡', () => {
  test('一度消された変更印を同じ時計で再登録しても、古い集計が新しい印を消さない', async () => {
    const organization = await createOrganization({ attachment_quota_bytes: 1000 });
    const admin = await createUser(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, admin.id);
    const attachment = await createAttachment(organization, workspace.id, admin.id, { size_bytes: 700 });
    const common = commonDb(env);
    const db = orgDb(env, organization.verified);
    const state = () =>
      common.first(
        common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', organization.id)),
      );
    await markAttachmentQuotaCheck(env, organization.id, at);
    let interleaved = false;
    const stale = envWithD1Hooks(env, {
      afterQuery: async (sql) => {
        if (!interleaved && sql.includes('wiki_page_revisions')) {
          interleaved = true;
          // A は700バイトを読んだところ。B が同じ状態を確認して旧変更印を消す。
          await reconcileAttachmentQuota(env, organization.id, at);
          expect((await state())!.attachment_quota_check_pending_at).toBeNull();
          // B の後に保存が確定し、固定時計または同一ミリ秒で変更印を再登録する。
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('attachments')
                .set({ size_bytes: 900 })
                .where('id', '=', attachment.id)
                .where('workspace_id', '=', workspace.id),
            ),
          ]);
          await markAttachmentQuotaCheck(env, organization.id, at);
          expect((await state())!.attachment_quota_check_pending_at).not.toBeNull();
        }
      },
    });
    await reconcileAttachmentQuota(stale, organization.id, at);
    expect(interleaved).toBe(true);
    const after = (await state())!;
    expect(
      after.attachment_quota_check_pending_at,
      '古い700バイトの結果で新しい900バイトの変更待ちを消さない',
    ).not.toBeNull();
    await env.ATTACHMENTS.delete('system/attachment-quota-warning-cursor');
    await attachmentQuotaWarningJob(env, new Date(at.getTime() + 60_000));
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('notifications').selectAll().where('user_id', '=', admin.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('attachment_quota_warning');
  });
});
