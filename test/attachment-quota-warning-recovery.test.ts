import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { cleanupReadNotifications, commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { attachmentQuotaWarningJob } from '../src/server/scheduled/attachment-quota-warning.ts';
import { createAttachment, createOrganization, createUser, createWorkspace } from './factories.ts';
import { createTarget, testEnv } from './operations/world.ts';
import { objectKeysOf, pngFile, upload } from './attachment-helpers.ts';

const at = new Date('2026-11-10T08:00:00.000Z');
const later = new Date('2026-11-11T08:00:00.000Z');
async function fixture() {
  const organization = await createOrganization({ attachment_quota_bytes: 1000 });
  const admin = await createUser(organization, { is_admin: 1 });
  const workspace = await createWorkspace(organization, admin.id);
  await createAttachment(organization, workspace.id, admin.id, { size_bytes: 900 });
  const db = orgDb(env, organization.verified);
  const common = commonDb(env);
  const notifications = () =>
    db.rows(db.statement((q) => q.selectFrom('notifications').selectAll().where('user_id', '=', admin.id)));
  const state = () =>
    common.first(
      common.statement((q) =>
        q
          .selectFrom('organizations')
          .select(['attachment_quota_warned_at', 'attachment_quota_warning_pending_at'])
          .where('id', '=', organization.id),
      ),
    );
  return { organization, admin, db, notifications, state };
}

describe('容量警告の再試行と保持', () => {
  test('時計が同じ日時でも、80%未満に戻ってからの再超過は別の通知になる', async () => {
    const target = await fixture();
    await reconcileAttachmentQuota(env, target.organization.id, at);
    await target.db.batch([
      target.db.statement((q) =>
        q
          .updateTable('attachments')
          .set({ size_bytes: 799 })
          .where('workspace_id', 'in', (eb) =>
            eb.selectFrom('workspaces').select('id').where('organization_id', '=', target.organization.id),
          ),
      ),
    ]);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    await target.db.batch([
      target.db.statement((q) =>
        q
          .updateTable('attachments')
          .set({ size_bytes: 900 })
          .where('workspace_id', 'in', (eb) =>
            eb.selectFrom('workspaces').select('id').where('organization_id', '=', target.organization.id),
          ),
      ),
    ]);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    const rows = await target.notifications();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });
  for (const failure of ['before', 'after'] as const) {
    test(`通知の保存${failure === 'before' ? '前' : '後'}に失敗しても、再試行で1件になり pending を消す`, async () => {
      const target = await fixture();
      const fail = (sqls: readonly string[]) => {
        if (sqls.some((sql) => sql.startsWith('insert into "notifications"'))) throw new Error('失敗');
      };
      const failing = envWithD1Hooks(env, failure === 'before' ? { beforeBatch: fail } : { afterBatch: fail });
      await expect(reconcileAttachmentQuota(failing, target.organization.id, at)).rejects.toThrow();
      expect(await target.state()).toEqual({
        attachment_quota_warned_at: at.toISOString(),
        attachment_quota_warning_pending_at: at.toISOString(),
      });
      await reconcileAttachmentQuota(env, target.organization.id, later);
      const rows = await target.notifications();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.created_at).toBe(at.toISOString());
      expect(await target.state()).toEqual({
        attachment_quota_warned_at: at.toISOString(),
        attachment_quota_warning_pending_at: null,
      });
    });
  }
  test('既読90日より古い通知だけ消え、未読と他の組織は残る。掃除後に同じ警告を作り直さない', async () => {
    const target = await fixture();
    const other = await fixture();
    await reconcileAttachmentQuota(env, target.organization.id, at);
    await reconcileAttachmentQuota(env, other.organization.id, at);
    const [row] = await target.notifications();
    const readAt = '2026-08-01T00:00:00.000Z';
    await target.db.batch([
      target.db.statement((q) => q.updateTable('notifications').set({ read_at: readAt }).where('id', '=', row!.id)),
    ]);
    await expect(cleanupReadNotifications(env, other.organization.id, '2026-08-02T00:00:00.000Z', 1000)).resolves.toBe(
      0,
    );
    await expect(cleanupReadNotifications(env, target.organization.id, readAt, 1000)).resolves.toBe(0);
    await expect(cleanupReadNotifications(env, target.organization.id, '2026-08-02T00:00:00.000Z', 1000)).resolves.toBe(
      1,
    );
    await reconcileAttachmentQuota(env, target.organization.id, later);
    expect(await target.notifications()).toEqual([]);
    expect(await other.notifications()).toHaveLength(1);
  });
  test('毎分の定期処理が pending を再試行し、停止している組織は通知しない', async () => {
    const target = await fixture();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q
          .updateTable('organizations')
          .set({
            attachment_quota_warned_at: at.toISOString(),
            attachment_quota_warning_pending_at: at.toISOString(),
          })
          .where('id', '=', target.organization.id),
      ),
    ]);
    const stopped = await fixture();
    await common.batch([
      common.statement((q) =>
        q
          .updateTable('organizations')
          .set({ suspended_at: at.toISOString() })
          .where('id', '=', stopped.organization.id),
      ),
    ]);
    await attachmentQuotaWarningJob(env, later);
    expect(await target.notifications()).toHaveLength(1);
    expect((await target.state())?.attachment_quota_warning_pending_at).toBeNull();
    expect(await stopped.notifications()).toEqual([]);
  });
  test('通知の保存に失敗してもアップロードは成功し、R2を消さない。定期処理で警告を届ける', async () => {
    const target = await createTarget();
    const file = pngFile();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q
          .updateTable('organizations')
          .set({ attachment_quota_bytes: file.length })
          .where('id', '=', target.organization.id),
      ),
    ]);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "notifications"'))) throw new Error('秘密の例外');
      },
    });
    const response = await upload(target, { file, env: failing });
    expect(response.status).toBe(200);
    expect(await objectKeysOf(target.organization.id)).toHaveLength(1);
    expect(errorLog.mock.calls.map((call) => String(call[0])).join('')).not.toContain('秘密の例外');
    errorLog.mockRestore();
    await reconcileAttachmentQuota(env, target.organization.id, later);
    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('notifications').select('id').where('user_id', '=', target.admin.userId!)),
    );
    expect(rows).toHaveLength(1);
  });
});
