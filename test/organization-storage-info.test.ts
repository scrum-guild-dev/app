import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { listOrganizations } from '../src/shared/operations/operator/index.ts';
import { type OutputOf } from '../src/shared/operations/define.ts';
import {
  AT,
  createAttachment,
  createMembership,
  createOrganization,
  createUser,
  createWorkspace,
  uuidv7,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations);

test('管理者だけに全ワークスペースと組織 Wiki の容量と上限を返す。運用者にも合計だけを返す', async () => {
  const organization = await createOrganization({ attachment_quota_bytes: 10000 });
  const admin = await createPerson({ organization, admin: true });
  const member = await createPerson({ organization });
  const first = await createWorkspace(organization, admin.userId!, { name: 'あおば' });
  const closed = await createWorkspace(organization, admin.userId!, { name: 'ひばり', closed_at: AT });
  await createMembership(organization, first.id, member.userId!);
  await createAttachment(organization, first.id, admin.userId!, { size_bytes: 17 });
  await createAttachment(organization, closed.id, admin.userId!, { size_bytes: 23 });
  const db = orgDb(env, organization.verified);
  const pageId = uuidv7();
  await db.batch([
    db.statement((q) =>
      q.insertInto('wiki_pages').values({
        id: pageId,
        organization_id: organization.id,
        workspace_id: null,
        parent_id: null,
        position: 'a0',
        title: '題🌿',
        body_md: '本文',
        version: 2,
        created_by: admin.userId!,
        updated_by: admin.userId!,
        created_at: AT,
        updated_at: AT,
        deleted_at: AT,
        deleted_by: admin.userId!,
      }),
    ),
    db.statement((q) =>
      q.insertInto('wiki_page_revisions').values({
        page_id: pageId,
        version: 1,
        title: '旧題',
        body_md: '過去',
        saved_by: admin.userId!,
        saved_at: AT,
      }),
    ),
  ]);
  const wikiBytes = new TextEncoder().encode('題🌿本文旧題過去').byteLength;
  const other = await createOrganization();
  const otherAdmin = await createUser(other, { is_admin: 1 });
  const otherWorkspace = await createWorkspace(other, otherAdmin.id);
  await createAttachment(other, otherWorkspace.id, otherAdmin.id, { size_bytes: 999 });

  const adminResponse = await post(app, organizationInfo, { slug: organization.slug, token: admin.token });
  expect(adminResponse.status).toBe(200);
  const result = (await adminResponse.json()) as OutputOf<typeof organizationInfo>;
  expect(result.storage).toEqual({
    used_bytes: 40 + wikiBytes,
    quota_bytes: 10000,
    organization_wiki_bytes: wikiBytes,
    workspaces: [
      { id: first.id, name: 'あおば', used_bytes: 17 },
      { id: closed.id, name: 'ひばり', used_bytes: 23 },
    ],
  });
  const memberResponse = await post(app, organizationInfo, { slug: organization.slug, token: member.token });
  expect(memberResponse.status).toBe(200);
  const memberResult = (await memberResponse.json()) as OutputOf<typeof organizationInfo>;
  expect(memberResult.storage).toBeNull();
  expect(JSON.stringify(memberResult)).not.toContain(closed.id);
  const response = await post(app, listOrganizations, { token: (await withNewSession(await getOperator())).token });
  expect(response.status).toBe(200);
  const listed = (await response.json()) as OutputOf<typeof listOrganizations>;
  const item = listed.organizations.find((row) => row.slug === organization.slug);
  expect(item?.attachment_used_bytes).toBe(40 + wikiBytes);
  expect(JSON.stringify(item)).not.toContain(first.id);
  expect(JSON.stringify(item)).not.toContain(pageId);
});
