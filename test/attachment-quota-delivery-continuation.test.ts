import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { cleanupReadNotifications, commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { createAttachment, createOrganization, createUser, createWorkspace, uuidv7 } from './factories.ts';

const at = new Date('2026-11-10T08:00:00.000Z');

async function fixture(admins = 1) {
  const organization = await createOrganization({ attachment_quota_bytes: 1000, member_limit: 100 });
  const users: Awaited<ReturnType<typeof createUser>>[] = [];
  for (let i = 0; i < admins; i++) users.push(await createUser(organization, { is_admin: 1 }));
  const workspace = await createWorkspace(organization, users[0]!.id);
  await createAttachment(organization, workspace.id, users[0]!.id, { size_bytes: 900 });
  const db = orgDb(env, organization.verified);
  const common = commonDb(env);
  const notifications = () =>
    db.rows(
      db.statement((q) =>
        q
          .selectFrom('notifications')
          .selectAll()
          .where(
            'user_id',
            'in',
            users.map((user) => user.id),
          ),
      ),
    );
  return { organization, users, db, common, notifications };
}

describe('容量警告の配信継続と掃除', () => {
  test('周期確保の直後に上限が上がり周期が取り消されたら、古い上限の通知を配信しない', async () => {
    const target = await fixture();
    let raised = false;
    const concurrent = envWithD1Hooks(env, {
      afterBatch: async (sqls) => {
        if (!raised && sqls.some((sql) => sql.startsWith('update "organizations" set "attachment_quota_warned_at"'))) {
          raised = true;
          await target.common.batch([
            target.common.statement((q) =>
              q
                .updateTable('organizations')
                .set({
                  attachment_quota_bytes: 2000,
                  attachment_quota_warned_at: null,
                  attachment_quota_warning_pending_at: null,
                })
                .where('id', '=', target.organization.id),
            ),
          ]);
        }
      },
    });
    await reconcileAttachmentQuota(concurrent, target.organization.id, at);
    expect(raised).toBe(true);
    expect(await target.notifications()).toEqual([]);
  });

  test('51人の管理者への配信で最初の50人の後に停止したら、次の配信batchを送らない', async () => {
    const target = await fixture(51);
    let batches = 0;
    const concurrent = envWithD1Hooks(env, {
      afterBatch: async (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "notifications"'))) {
          batches++;
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
    await reconcileAttachmentQuota(concurrent, target.organization.id, at);
    expect(batches).toBe(1);
    expect(await target.notifications()).toHaveLength(50);
    await target.common.batch([
      target.common.statement((q) =>
        q.updateTable('organizations').set({ suspended_at: null }).where('id', '=', target.organization.id),
      ),
    ]);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    const delivered = await target.notifications();
    expect(delivered).toHaveLength(51);
    expect(new Set(delivered.map((row) => row.user_id)).size).toBe(51);
  });

  test('既読の掃除が1回の件数上限を守り、未読を消さず繰り返しで残りを消す', async () => {
    const target = await fixture();
    const userId = target.users[0]!.id;
    const cutoff = '2026-08-02T00:00:00.000Z';
    await target.db.batch(
      Array.from({ length: 6 }, (_, index) =>
        target.db.statement((q) =>
          q.insertInto('notifications').values({
            id: uuidv7(),
            user_id: userId,
            kind: 'attachment_quota_warning',
            payload_json: '{}',
            read_at: index === 5 ? null : '2026-08-01T00:00:00.000Z',
            created_at: '2026-08-01T00:00:00.000Z',
          }),
        ),
      ),
    );
    expect(await cleanupReadNotifications(env, target.organization.id, cutoff, 2)).toBe(2);
    expect(await target.notifications()).toHaveLength(4);
    expect(await cleanupReadNotifications(env, target.organization.id, cutoff, 2)).toBe(2);
    expect(await cleanupReadNotifications(env, target.organization.id, cutoff, 2)).toBe(1);
    expect(await cleanupReadNotifications(env, target.organization.id, cutoff, 2)).toBe(0);
    expect(await target.notifications()).toHaveLength(1);
    expect((await target.notifications())[0]?.read_at).toBeNull();
  });
});
