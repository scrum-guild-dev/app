import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  orgWikiPage,
  orgWikiRevisions,
  workspaceWikiCreate,
  workspaceWikiPage,
  workspaceWikiRevisions,
  workspaceWikiUpdate,
} from '../src/shared/operations/wiki/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import type { WikiPage } from '../src/shared/operations/wiki/index.ts';
import { post, errorCodeOf } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';
import { AT } from './factories.ts';

const app = createApp(implementedOperations);
function call(
  target: Target,
  operation: AnyOperationDefinition,
  input: Record<string, unknown>,
  token = target.member.token,
) {
  return post(app, operation, { slug: target.slug, token, body: { workspace_id: target.workspace.id, ...input } });
}
async function create(target: Target) {
  const response = await call(target, workspaceWikiCreate, { title: '初めの題', body_md: '# 初めの本文' });
  expect(response.status).toBe(200);
  return ((await response.json()) as { page: WikiPage }).page;
}
async function save(target: Target, page: WikiPage, body: string, token = target.member.token) {
  const response = await call(
    target,
    workspaceWikiUpdate,
    { page_id: page.id, read_version: page.version, title: '新しい題', body_md: body },
    token,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { page: WikiPage }).page;
}

test('版は新しい順で保存者と日時を返し、前の題と本文を読み、復元は新しい版になる', async () => {
  const target = await createTarget();
  const initial = await create(target);
  const second = await save(target, initial, '# 二番目の本文', target.leader.token);
  const response = await call(target, workspaceWikiRevisions, { page_id: initial.id });
  expect(response.status).toBe(200);
  const { revisions } = (await response.json()) as { revisions: Record<string, unknown>[] };
  expect(revisions).toMatchObject([
    {
      version: 2,
      saved_by: target.leader.userId,
      saved_by_name: expect.any(String),
      saved_at: expect.any(String),
      title: '新しい題',
    },
    { version: 1, saved_by: target.member.userId, saved_at: initial.created_at, title: initial.title },
  ]);
  expect(revisions.every((item) => !('body_md' in item))).toBe(true);
  const historical = await call(target, workspaceWikiPage, { page_id: initial.id, revision: 1 });
  expect(historical.status).toBe(200);
  const { page } = (await historical.json()) as { page: WikiPage };
  expect(page).toMatchObject({ id: initial.id, version: 1, title: initial.title, body_md: initial.body_md });
  const restore = await call(target, workspaceWikiUpdate, {
    page_id: initial.id,
    read_version: second.version,
    title: page.title,
    body_md: page.body_md,
  });
  expect(restore.status).toBe(200);
  expect(await restore.json()).toMatchObject({ page: { version: 3, title: initial.title, body_md: initial.body_md } });
  const after = await call(target, workspaceWikiRevisions, { page_id: initial.id });
  expect(((await after.json()) as { revisions: { version: number }[] }).revisions.map((item) => item.version)).toEqual([
    3, 2, 1,
  ]);
});

test('復元の前に他の人が保存すると断り、前の版と今の本文を変えない', async () => {
  const target = await createTarget();
  const initial = await create(target);
  const second = await save(target, initial, '第2版');
  const third = await save(target, second, '他の人の本文', target.leader.token);
  const result = await call(target, workspaceWikiUpdate, {
    page_id: initial.id,
    read_version: second.version,
    title: initial.title,
    body_md: initial.body_md,
  });
  expect(result.status).toBe(409);
  expect(await errorCodeOf(result)).toBe('conflict');
  const current = await call(target, workspaceWikiPage, { page_id: initial.id });
  expect(await current.json()).toMatchObject({ page: third });
});

test('組織とワークスペースの範囲外、存在しない版、削除されたページは404', async () => {
  const target = await createTarget();
  const foreign = await createTarget();
  const local = await create(target);
  const other = await create(foreign);
  const anotherWorkspace = await create({ ...target, workspace: target.otherWorkspace, member: target.admin });
  for (const id of [other.id, anotherWorkspace.id, crypto.randomUUID()]) {
    for (const op of [workspaceWikiPage, workspaceWikiRevisions]) {
      const response = await call(target, op, { page_id: id, revision: 1 });
      expect(response.status).toBe(404);
    }
  }
  for (const revision of [2, 999])
    expect((await call(target, workspaceWikiPage, { page_id: local.id, revision })).status).toBe(404);
  for (const revision of [0, -1, 1.5, '1'])
    expect((await call(target, workspaceWikiPage, { page_id: local.id, revision })).status).toBe(400);
  expect((await call(target, workspaceWikiRevisions, { page_id: local.id }, target.bystander.token)).status).toBe(404);
  for (const op of [orgWikiPage, orgWikiRevisions])
    expect((await call(target, op, { page_id: local.id, revision: 1 })).status).toBe(404);
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('wiki_pages')
        .set({ deleted_at: AT, deleted_by: target.member.userId! })
        .where('id', '=', local.id)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
  for (const op of [workspaceWikiPage, workspaceWikiRevisions])
    expect((await call(target, op, { page_id: local.id, revision: 1 })).status).toBe(404);
});

test('組織のページの版を読めるが、別組織からは読めない', async () => {
  const target = await createTarget();
  const other = await createTarget();
  const initial = await create(target);
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('wiki_pages')
        .set({ workspace_id: null, organization_id: target.organization.id })
        .where('id', '=', initial.id)
        .where('workspace_id', '=', target.workspace.id),
    ),
  );
  for (const op of [orgWikiPage, orgWikiRevisions]) {
    expect((await call(target, op, { page_id: initial.id, revision: 1 }, target.bystander.token)).status).toBe(200);
    expect((await call(other, op, { page_id: initial.id, revision: 1 })).status).toBe(404);
    expect((await call(target, workspaceWikiRevisions, { page_id: initial.id })).status).toBe(404);
  }
});

test('101版目を保存するとAPIには新しい100版だけが残り、消えた版は読めない', async () => {
  const target = await createTarget();
  const initial = await create(target);
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q
        .updateTable('wiki_pages')
        .set({ version: 100 })
        .where('id', '=', initial.id)
        .where('workspace_id', '=', target.workspace.id),
    ),
    ...Array.from({ length: 99 }, (_, i) =>
      db.statement((q) =>
        q.insertInto('wiki_page_revisions').values({
          page_id: initial.id,
          version: i + 2,
          title: initial.title,
          body_md: initial.body_md,
          saved_by: target.member.userId!,
          saved_at: AT,
        }),
      ),
    ),
  ]);
  await save(target, { ...initial, version: 100 }, '101版');
  const response = await call(target, workspaceWikiRevisions, { page_id: initial.id });
  const { revisions } = (await response.json()) as { revisions: { version: number }[] };
  expect(revisions.map((item) => item.version)).toEqual(Array.from({ length: 100 }, (_, i) => 101 - i));
  expect((await call(target, workspaceWikiPage, { page_id: initial.id, revision: 1 })).status).toBe(404);
  expect((await call(target, workspaceWikiPage, { page_id: initial.id, revision: 2 })).status).toBe(200);
});
