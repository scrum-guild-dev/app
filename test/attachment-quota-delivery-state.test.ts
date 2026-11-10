import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { createAttachment, createOrganization, createUser, createWorkspace } from './factories.ts';

const at = new Date('2026-11-10T08:00:00.000Z');
const readAt = '2026-11-10T08:01:00.000Z';

async function fixture() {
  const organization = await createOrganization({ attachment_quota_bytes: 1000 });
  const admin = await createUser(organization, { is_admin: 1 });
  const workspace = await createWorkspace(organization, admin.id);
  await createAttachment(organization, workspace.id, admin.id, { size_bytes: 900 });
  const db = orgDb(env, organization.verified);
  const common = commonDb(env);
  const notifications = () =>
    db.rows(db.statement((q) => q.selectFrom('notifications').selectAll().where('user_id', '=', admin.id)));
  return { organization, admin, db, common, notifications };
}

describe('容量警告の配信中の状態変更', () => {
  test('通知を保存して応答を失った後に本人が既読にしても、再試行で既読を戻さない', async () => {
    const target = await fixture();
    const interrupted = envWithD1Hooks(env, {
      afterBatch: async (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "notifications"'))) {
          await target.db.batch([
            target.db.statement((q) =>
              q.updateTable('notifications').set({ read_at: readAt }).where('user_id', '=', target.admin.id),
            ),
          ]);
          throw new Error('通知の応答だけ失われた');
        }
      },
    });
    await expect(reconcileAttachmentQuota(interrupted, target.organization.id, at)).rejects.toThrow();
    await reconcileAttachmentQuota(env, target.organization.id, new Date(readAt));
    const rows = await target.notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.read_at).toBe(readAt);
  });

  test('通知周期を確保した直後に組織が停止したら、その組織へ通知を保存しない', async () => {
    const target = await fixture();
    let stopped = false;
    const interrupted = envWithD1Hooks(env, {
      afterBatch: async (sqls) => {
        if (!stopped && sqls.some((sql) => sql.startsWith('update "organizations" set "attachment_quota_warned_at"'))) {
          stopped = true;
          await target.common.batch([
            target.common.statement((q) =>
              q
                .updateTable('organizations')
                .set({ suspended_at: at.toISOString() })
                .where('id', '=', target.organization.id),
            ),
          ]);
        }
      },
    });
    await reconcileAttachmentQuota(interrupted, target.organization.id, at);
    expect(stopped).toBe(true);
    expect(await target.notifications()).toEqual([]);
  });

  test('周期を確保した後で管理者が解除された受取人へは通知しない', async () => {
    const target = await fixture();
    let revoked = false;
    const interrupted = envWithD1Hooks(env, {
      afterBatch: async (sqls) => {
        if (!revoked && sqls.some((sql) => sql.startsWith('update "organizations" set "attachment_quota_warned_at"'))) {
          revoked = true;
          await target.db.batch([
            target.db.statement((q) =>
              q
                .updateTable('users')
                .set({ is_admin: 0 })
                .where('id', '=', target.admin.id)
                .where('organization_id', '=', target.organization.id),
            ),
          ]);
        }
      },
    });
    await reconcileAttachmentQuota(interrupted, target.organization.id, at);
    expect(revoked).toBe(true);
    expect(await target.notifications()).toEqual([]);
  });
});
