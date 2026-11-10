import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, markAttachmentQuotaCheck, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { attachmentQuotaWarningJob } from '../src/server/scheduled/attachment-quota-warning.ts';
import { createAttachment, createOrganization, createUser, createWorkspace } from './factories.ts';

const at = new Date('2026-11-10T08:00:00.000Z');

describe('容量警告のレビュー修正への独立反証 第3巡', () => {
  test('古い確認が周期を確保する前に配信・リセット・再超過しても、新しい警告を既存通知と同じ周期に潰さない', async () => {
    const organization = await createOrganization({ attachment_quota_bytes: 1000 });
    const admin = await createUser(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, admin.id);
    const attachment = await createAttachment(organization, workspace.id, admin.id, { size_bytes: 900 });
    const common = commonDb(env);
    const db = orgDb(env, organization.verified);
    const notifications = () =>
      db.rows(db.statement((q) => q.selectFrom('notifications').selectAll().where('user_id', '=', admin.id)));
    const changeBytes = async (bytes: number) => {
      await db.batch([
        db.statement((q) => q.updateTable('attachments').set({ size_bytes: bytes }).where('id', '=', attachment.id)),
      ]);
      await markAttachmentQuotaCheck(env, organization.id, at);
    };
    await markAttachmentQuotaCheck(env, organization.id, at);
    let interleaved = false;
    const stale = envWithD1Hooks(env, {
      afterQuery: async (query) => {
        if (!interleaved && query.includes('max("n"."created_at")')) {
          interleaved = true;
          // A はまだ通知がない履歴を読んだ。先に B が同じ超過を通知し、本人が既読にする。
          await reconcileAttachmentQuota(env, organization.id, at);
          const first = await notifications();
          expect(first).toHaveLength(1);
          await db.batch([
            db.statement((q) =>
              q.updateTable('notifications').set({ read_at: at.toISOString() }).where('id', '=', first[0]!.id),
            ),
          ]);
          // 同じ時計で新しい超過まで進む。周期の履歴を取り直せば次の周期は前の通知より後になる。
          await changeBytes(799);
          await reconcileAttachmentQuota(env, organization.id, at);
          await changeBytes(900);
        }
      },
    });
    await reconcileAttachmentQuota(stale, organization.id, at);
    expect(interleaved).toBe(true);
    await env.ATTACHMENTS.delete('system/attachment-quota-warning-cursor');
    await attachmentQuotaWarningJob(env, new Date(at.getTime() + 60_000));
    const rows = await notifications();
    expect(rows, '80%未満に戻った後の再超過は既存の既読通知と別の警告として届く').toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.filter((row) => row.read_at === at.toISOString())).toHaveLength(1);
    const state = await common.first(
      common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', organization.id)),
    );
    expect(state?.attachment_quota_warning_pending_at).toBeNull();
    expect(state?.attachment_quota_check_pending_at).toBeNull();
  });
});
