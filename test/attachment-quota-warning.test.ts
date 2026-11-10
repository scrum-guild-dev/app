// #740: 本番のマイグレーションで作る通知の表を、組織の入口から検証する。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { AT, createAttachment, createOrganization, createUser, createWorkspace, uuidv7 } from './factories.ts';

const at = new Date('2026-11-10T08:00:00.000Z');
const later = new Date('2026-11-11T08:00:00.000Z');

async function fixture(sizeBytes: number, warnedAt: string | null = null) {
  const organization = await createOrganization({
    attachment_quota_bytes: 1000,
    attachment_quota_warned_at: warnedAt,
  });
  const admin = await createUser(organization, { is_admin: 1 });
  const secondAdmin = await createUser(organization, { is_admin: 1 });
  const member = await createUser(organization);
  const disabledAdmin = await createUser(organization, { is_admin: 1, disabled_at: AT });
  const workspace = await createWorkspace(organization, admin.id);
  const attachment = await createAttachment(organization, workspace.id, member.id, { size_bytes: sizeBytes });
  return { organization, admin, secondAdmin, member, disabledAdmin, workspace, attachment };
}

type Target = Awaited<ReturnType<typeof fixture>>;
async function notifications(target: Target) {
  const ids = [target.admin.id, target.secondAdmin.id, target.member.id, target.disabledAdmin.id];
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q.selectFrom('notifications').selectAll().where('user_id', 'in', ids).orderBy('user_id').orderBy('created_at'),
    ),
  );
}

async function warnedAt(target: Target) {
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('organizations').select('attachment_quota_warned_at').where('id', '=', target.organization.id),
    ),
  );
  return row?.attachment_quota_warned_at;
}

async function changeBytes(target: Target, bytes: number) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) => q.updateTable('attachments').set({ size_bytes: bytes }).where('id', '=', target.attachment.id)),
  );
}

describe('添付ファイルと Wiki の80%の通知', () => {
  test('80%を超えると有効な管理者全員だけに使用量と上限を通知し、日時を保存する', async () => {
    const target = await fixture(801);
    const other = await fixture(901);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    const rows = await notifications(target);
    expect(rows.map((row) => row.user_id).sort()).toEqual([target.admin.id, target.secondAdmin.id].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: 'attachment_quota_warning',
        workspace_id: null,
        task_id: null,
        epic_id: null,
        connection_id: null,
        actor_user_id: null,
        read_at: null,
        created_at: at.toISOString(),
      });
      expect(JSON.parse(row.payload_json)).toEqual({ used_bytes: 801, quota_bytes: 1000 });
    }
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(await warnedAt(target)).toBe(at.toISOString());
    expect(await notifications(other)).toEqual([]);
    expect(await warnedAt(other)).toBeNull();
  });

  test('ちょうど80%なら新たに通知しない', async () => {
    const target = await fixture(800);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    expect(await notifications(target)).toEqual([]);
    expect(await warnedAt(target)).toBeNull();
  });

  test('通知済みの組織は何回確認しても重ねて通知しない', async () => {
    const target = await fixture(950, AT);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    await reconcileAttachmentQuota(env, target.organization.id, later);
    expect(await notifications(target)).toEqual([]);
    expect(await warnedAt(target)).toBe(AT);
  });

  test('同時の確認でも各管理者に1回だけ通知する', async () => {
    const target = await fixture(900);
    await Promise.all(Array.from({ length: 5 }, () => reconcileAttachmentQuota(env, target.organization.id, at)));
    const rows = await notifications(target);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.user_id).sort()).toEqual([target.admin.id, target.secondAdmin.id].sort());
    expect(await warnedAt(target)).toBe(at.toISOString());
  });

  test('80%未満になると日時を消し、次に超えた時はまた通知する。ちょうど80%では日時を維持する', async () => {
    const target = await fixture(800, AT);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    expect(await warnedAt(target)).toBe(AT);
    expect(await notifications(target)).toEqual([]);
    await changeBytes(target, 799);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    expect(await warnedAt(target)).toBeNull();
    await changeBytes(target, 801);
    await reconcileAttachmentQuota(env, target.organization.id, later);
    expect(await notifications(target)).toHaveLength(2);
    expect(await warnedAt(target)).toBe(later.toISOString());
  });

  test('上限を引き上げ80%未満になれば、次に超えた時は増やした上限で通知する', async () => {
    const target = await fixture(900);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    const db = commonDb(env);
    await db.run(
      db.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: 2000 }).where('id', '=', target.organization.id),
      ),
    );
    await reconcileAttachmentQuota(env, target.organization.id, later);
    expect(await warnedAt(target)).toBeNull();
    await changeBytes(target, 1601);
    await reconcileAttachmentQuota(env, target.organization.id, later);
    const rows = await notifications(target);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.created_at === later.toISOString())).toHaveLength(2);
    for (const row of rows.filter((row) => row.created_at === later.toISOString())) {
      expect(JSON.parse(row.payload_json)).toEqual({ used_bytes: 1601, quota_bytes: 2000 });
    }
  });

  test('添付だけでなく組織と閉じたワークスペースの Wiki の題・本文と過去版・削除保持分も数える', async () => {
    const target = await fixture(750);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) => q.updateTable('workspaces').set({ closed_at: AT }).where('id', '=', target.workspace.id)),
    );
    let bytes = 750;
    for (const scope of ['organization', 'workspace'] as const) {
      const id = uuidv7();
      const title = '題🌸';
      const body_md = 'あおばの本文';
      bytes += new TextEncoder().encode(title + body_md + title + body_md).byteLength;
      await db.batch([
        db.statement((q) =>
          q.insertInto('wiki_pages').values({
            id,
            organization_id: scope === 'organization' ? target.organization.id : null,
            workspace_id: scope === 'workspace' ? target.workspace.id : null,
            parent_id: null,
            position: 'a0',
            title,
            body_md,
            version: 2,
            created_by: target.admin.id,
            updated_by: target.admin.id,
            created_at: AT,
            updated_at: AT,
            deleted_at: AT,
            deleted_by: target.admin.id,
          }),
        ),
        db.statement((q) =>
          q.insertInto('wiki_page_revisions').values({
            page_id: id,
            version: 1,
            title,
            body_md,
            saved_by: target.admin.id,
            saved_at: AT,
          }),
        ),
      ]);
    }
    expect(bytes).toBeGreaterThan(800);
    await reconcileAttachmentQuota(env, target.organization.id, at);
    const rows = await notifications(target);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(JSON.parse(row.payload_json)).toEqual({ used_bytes: bytes, quota_bytes: 1000 });
  });
});
