import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/server/app.ts';
import { implement } from '../src/server/operations/implement.ts';
import { attachmentQuotaWarningJob } from '../src/server/scheduled/attachment-quota-warning.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv } from './operations/world.ts';
import { commonDb, markAttachmentQuotaCheck, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { createAttachment, createOrganization, createUser, createWorkspace } from './factories.ts';

const at = new Date('2026-11-10T08:00:00.000Z');

async function fixture(admins: number, sizeBytes: number) {
  const organization = await createOrganization({ attachment_quota_bytes: 1000, member_limit: 1000 });
  const users = [];
  for (let i = 0; i < admins; i++) users.push(await createUser(organization, { is_admin: 1 }));
  const workspace = await createWorkspace(organization, users[0]!.id);
  await createAttachment(organization, workspace.id, users[0]!.id, { size_bytes: sizeBytes });
  const common = commonDb(env);
  const db = orgDb(env, organization.verified);
  const state = () =>
    common.first(common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', organization.id)));
  const notifications = () =>
    db.rows(
      db.statement((q) =>
        q
          .selectFrom('notifications')
          .innerJoin('users', 'users.id', 'notifications.user_id')
          .selectAll('notifications')
          .where('users.organization_id', '=', organization.id),
      ),
    );
  return { organization, db, state, notifications };
}

describe('容量警告のCIレビュー修正への独立反証', () => {
  test('保存後の変更印の登録が一度失敗しても保存は成功し、復旧後に通知を再試行する', async () => {
    const target = await createTarget();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: 1000 }).where('id', '=', target.organization.id),
      ),
    ]);
    const definition = defineOperation({
      name: 'test-quota-marker-failure',
      description: '保存と容量確認',
      mode: 'write',
      permission: 'organization',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    });
    const operation = implement(definition, async ({ tools }) => {
      await createAttachment(target.organization, target.workspace.id, target.admin.userId!, { size_bytes: 900 });
      await tools.reconcileAttachmentQuota();
      return { ok: true };
    });
    let failures = 0;
    const observed = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (
          failures === 0 &&
          sqls.some((sql) => /^update "organizations"/i.test(sql) && sql.includes('attachment_quota_check_pending_at'))
        ) {
          failures++;
          throw new Error('one transient dirty-marker failure');
        }
      },
    });
    const deferred: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const response = await post(createApp([operation]), definition, {
      slug: target.slug,
      token: target.admin.token,
      env: observed,
      executionCtx,
    });
    expect(response.status).toBe(200);
    expect(failures).toBe(1);
    await Promise.all(deferred);
    await env.ATTACHMENTS.delete('system/attachment-quota-warning-cursor');
    await attachmentQuotaWarningJob(testEnv, at);
    const db = orgDb(env, target.organization.verified);
    const attachments = await db.rows(
      db.statement((q) => q.selectFrom('attachments').select('id').where('workspace_id', '=', target.workspace.id)),
    );
    expect(attachments).toHaveLength(1);
    const notifications = await db.rows(
      db.statement((q) => q.selectFrom('notifications').selectAll().where('user_id', '=', target.admin.userId!)),
    );
    expect(notifications).toHaveLength(1);
  });
  test('集計中に同じ時計で変更印を再登録しても、古い集計は新しい印を消さない', async () => {
    const target = await fixture(1, 700);
    await markAttachmentQuotaCheck(env, target.organization.id, at);
    const before = (await target.state())!.attachment_quota_check_pending_at;
    let updated = false;
    const concurrent = envWithD1Hooks(env, {
      afterQuery: async (sql) => {
        if (!updated && /\bwiki_page_revisions\b/i.test(sql)) {
          updated = true;
          await markAttachmentQuotaCheck(env, target.organization.id, at);
        }
      },
    });
    await reconcileAttachmentQuota(concurrent, target.organization.id, at);
    expect(updated).toBe(true);
    const after = (await target.state())!.attachment_quota_check_pending_at;
    expect(after).not.toBeNull();
    expect(after! > before!).toBe(true);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    expect((await target.state())!.attachment_quota_check_pending_at).toBeNull();
  });

  test('251管理者は5batchの次回へ継続し、先に読まれた通知のIDと既読を保つ', async () => {
    const target = await fixture(251, 900);
    await markAttachmentQuotaCheck(env, target.organization.id, at);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    const first = await target.notifications();
    expect(first).toHaveLength(250);
    expect((await target.state())!.attachment_quota_warning_pending_at).not.toBeNull();
    expect((await target.state())!.attachment_quota_check_pending_at).not.toBeNull();
    const read = first[0]!;
    const readAt = new Date(at.getTime() + 1000).toISOString();
    await target.db.batch([
      target.db.statement((q) => q.updateTable('notifications').set({ read_at: readAt }).where('id', '=', read.id)),
    ]);
    await reconcileAttachmentQuota(env, target.organization.id, new Date(at.getTime() + 2000));
    const delivered = await target.notifications();
    expect(delivered).toHaveLength(251);
    expect(new Set(delivered.map((row) => row.user_id)).size).toBe(251);
    expect(delivered.find((row) => row.id === read.id)?.read_at).toBe(readAt);
    const final = (await target.state())!;
    expect(final.attachment_quota_warning_pending_at).toBeNull();
    expect(final.attachment_quota_check_pending_at).toBeNull();
    expect(final.attachment_quota_warned_at).toBe(at.toISOString());
  }, 30_000);
});
