// #740: 運用者の集計も、添付の容量判定と同じ範囲を数える。
/* eslint-disable db-entry/guard -- 複数 DB を表すテスト専用の追加入口を実際の D1 に接続し、集計の SQL や結果の列名に依存せず加算を検証するため */
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { organizationUsageForTest, type FakeDatabase } from '../src/server/db/testing.ts';
import {
  AT,
  createAttachment,
  createOrganization,
  createUser,
  createWorkspace,
  uuidv7,
  type OrganizationFixture,
} from './factories.ts';

async function seedWiki(
  organization: OrganizationFixture,
  userId: string,
  workspaceId: string | null,
  deleted = false,
) {
  const db = orgDb(env, organization.verified);
  const id = uuidv7();
  const current = { title: '現行🌿', body_md: '本文\nあおば' };
  const previous = { title: '旧版', body_md: '以前の本文🌸' };
  await db.batch([
    db.statement((q) =>
      q.insertInto('wiki_pages').values({
        id,
        organization_id: workspaceId === null ? organization.id : null,
        workspace_id: workspaceId,
        parent_id: null,
        position: 'a0',
        ...current,
        version: 2,
        created_by: userId,
        updated_by: userId,
        created_at: AT,
        updated_at: AT,
        deleted_at: deleted ? AT : null,
        deleted_by: deleted ? userId : null,
      }),
    ),
    db.statement((q) =>
      q.insertInto('wiki_page_revisions').values({
        page_id: id,
        version: 1,
        ...previous,
        saved_by: userId,
        saved_at: AT,
      }),
    ),
  ]);
  return new TextEncoder().encode(current.title + current.body_md + previous.title + previous.body_md).byteLength;
}

describe('組織ごとの容量の集計', () => {
  test('空の組織と未知の ID の合計は0、空の ID 一覧は空', async () => {
    const organization = await createOrganization();
    const unknownId = uuidv7();
    const usage = await organizationUsageForTest(env, [organization.id, unknownId], []);
    expect(usage.get(organization.id)).toMatchObject({ attachmentBytes: 0 });
    expect(usage.get(unknownId)).toMatchObject({ attachmentBytes: 0 });
    expect(await organizationUsageForTest(env, [], [])).toEqual(new Map());
  });

  test('全ワークスペースの添付と組織・ワークスペース Wiki の現行と過去版を UTF8 で数え、別組織を混ぜない', async () => {
    const organization = await createOrganization();
    const user = await createUser(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, user.id);
    const closed = await createWorkspace(organization, user.id, { closed_at: AT });
    await createAttachment(organization, workspace.id, user.id, { size_bytes: 101 });
    await createAttachment(organization, closed.id, user.id, { size_bytes: 203 });
    const orgWiki = await seedWiki(organization, user.id, null);
    const workspaceWiki = await seedWiki(organization, user.id, workspace.id);
    // 30日の保持中の削除済みページと閉じたワークスペースも使用量に残る。
    const retainedWiki = await seedWiki(organization, user.id, closed.id, true);
    const retainedOrgWiki = await seedWiki(organization, user.id, null, true);

    const other = await createOrganization();
    const otherUser = await createUser(other, { is_admin: 1 });
    const otherWorkspace = await createWorkspace(other, otherUser.id);
    await createAttachment(other, otherWorkspace.id, otherUser.id, { size_bytes: 9876 });
    const otherWiki = await seedWiki(other, otherUser.id, null);
    const ids = [...Array.from({ length: 120 }, uuidv7), organization.id, other.id];
    const usage = await organizationUsageForTest(env, ids, []);
    expect(usage.get(organization.id)).toMatchObject({
      attachmentBytes: 304 + orgWiki + workspaceWiki + retainedWiki + retainedOrgWiki,
    });
    expect(usage.get(other.id)).toMatchObject({ attachmentBytes: 9876 + otherWiki });
    expect(usage.get(ids[0]!)).toMatchObject({ attachmentBytes: 0 });
  });

  test('組織の DB が複数あれば、各 DB の容量を足す', async () => {
    const organization = await createOrganization();
    const user = await createUser(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, user.id);
    await createAttachment(organization, workspace.id, user.id, { size_bytes: 13 });
    const wikiBytes = await seedWiki(organization, user.id, null);
    // 同じ fixture を持つ2つ目の入口として実際の D1 に接続し、集計文数・結果の列名には依存させない。
    const extra: FakeDatabase = {
      prepare: (text) => ({
        bind: (...values) => ({
          all: async () => {
            const result = await env.DB.prepare(text)
              .bind(...values)
              .all();
            return { results: result.results, meta: { changes: result.meta.changes } };
          },
        }),
      }),
      batch: (statements) => Promise.all(statements.map((statement) => statement.all())),
    };
    const usage = await organizationUsageForTest(env, [organization.id], [extra]);
    expect(usage.get(organization.id)).toMatchObject({ attachmentBytes: (13 + wikiBytes) * 2 });
  });
});
