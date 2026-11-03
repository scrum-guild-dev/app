import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  orgWikiCreate,
  orgWikiPage,
  orgWikiTree,
  orgWikiUpdate,
  workspaceWikiCreate,
  workspaceWikiPage,
  workspaceWikiTree,
  workspaceWikiUpdate,
  type WikiPage,
} from '../src/shared/operations/wiki/index.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
function call(
  target: Target,
  definition: AnyOperationDefinition,
  body: Record<string, unknown> = {},
  person = target.member,
) {
  return post(app, definition, { slug: target.slug, token: person.token, body });
}
async function create(target: Target, body: Record<string, unknown> = {}) {
  const response = await call(target, orgWikiCreate, { title: '組織の手順', body_md: '本文', ...body });
  expect(response.status).toBe(200);
  return ((await response.json()) as { page: WikiPage }).page;
}
async function read(target: Target, id: string) {
  const response = await call(target, orgWikiPage, { page_id: id });
  expect(response.status).toBe(200);
  return ((await response.json()) as { page: WikiPage }).page;
}

describe('組織の Wiki', () => {
  test('別のワークスペースだけに所属する人も、同じ親子の木を読み書きできる', async () => {
    const target = await createTarget();
    const root = await create(target);
    const response = await call(
      target,
      orgWikiCreate,
      { parent_id: root.id, title: '子の手順', body_md: '# 準備' },
      target.bystander,
    );
    expect(response.status).toBe(200);
    const { page: child } = (await response.json()) as { page: WikiPage };
    expect(child.parent_id).toBe(root.id);
    const tree = await call(target, orgWikiTree, {}, target.bystander);
    const { pages } = (await tree.json()) as { pages: Record<string, unknown>[] };
    expect(pages.map((page) => page.id)).toEqual(expect.arrayContaining([root.id, child.id]));
    expect(pages).toHaveLength(2);
    expect(pages.every((page) => !('body_md' in page))).toBe(true);
    const saved = await call(
      target,
      orgWikiUpdate,
      { page_id: child.id, read_version: 1, title: '直した手順', body_md: '共有の本文' },
      target.admin,
    );
    expect(saved.status).toBe(200);
    expect(await read(target, child.id)).toMatchObject({
      id: child.id,
      title: '直した手順',
      body_md: '共有の本文',
      version: 2,
    });
  });

  test('組織とワークスペースの木・ページ・親・保存先が互いに混ざらない', async () => {
    const target = await createTarget();
    const root = await create(target);
    const workspace = { workspace_id: target.workspace.id };
    const response = await call(target, workspaceWikiCreate, {
      ...workspace,
      title: 'チームの手順',
      body_md: 'チームだけの本文',
    });
    const { page: local } = (await response.json()) as { page: WikiPage };
    const orgTree = await call(target, orgWikiTree);
    const wsTree = await call(target, workspaceWikiTree, workspace);
    expect(await orgTree.json()).toMatchObject({ pages: [{ id: root.id }] });
    expect(await wsTree.json()).toMatchObject({ pages: [{ id: local.id }] });
    for (const [definition, body] of [
      [orgWikiPage, { page_id: local.id }],
      [orgWikiUpdate, { page_id: local.id, read_version: 1, title: '改変', body_md: '改変' }],
      [orgWikiCreate, { parent_id: local.id, title: '混ぜる', body_md: '' }],
      [workspaceWikiPage, { ...workspace, page_id: root.id }],
      [workspaceWikiUpdate, { ...workspace, page_id: root.id, read_version: 1, title: '改変', body_md: '改変' }],
      [workspaceWikiCreate, { ...workspace, parent_id: root.id, title: '混ぜる', body_md: '' }],
    ] as const) {
      const denied = await call(target, definition, body);
      expect(denied.status).toBe(404);
      expect(await errorCodeOf(denied)).toBe('not_found');
    }
    expect(await read(target, root.id)).toEqual(root);
    const localRead = await call(target, workspaceWikiPage, { ...workspace, page_id: local.id });
    expect(await localRead.json()).toEqual({ page: local });
  });

  test('別の組織のページは読めず、保存も親への指定もできない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const page = await create(other);
    for (const [definition, input] of [
      [orgWikiPage, { page_id: page.id }],
      [orgWikiUpdate, { page_id: page.id, read_version: 1, title: '改変', body_md: '改変' }],
      [orgWikiCreate, { parent_id: page.id, title: '混ぜる', body_md: '' }],
    ] as const) {
      const response = await call(target, definition, input);
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('not_found');
    }
    expect(await read(other, page.id)).toEqual(page);
  });

  test('所属のない無効な人と別組織の人には、すべての操作で404を返す', async () => {
    const target = await createTarget();
    const page = await create(target);
    const disabled = await createPerson({ organization: target.organization, disabled: true });
    const leftAll = await createPerson({ organization: target.organization });
    const other = await createTarget();
    for (const person of [disabled, leftAll, other.member, target.invitee]) {
      for (const [definition, body] of [
        [orgWikiTree, {}],
        [orgWikiPage, { page_id: page.id }],
        [orgWikiCreate, { title: '新規', body_md: '' }],
        [orgWikiUpdate, { page_id: page.id, read_version: 1, title: '改変', body_md: '' }],
      ] as const) {
        const response = await call(target, definition, body, person);
        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe('not_found');
      }
    }
    expect(await read(target, page.id)).toEqual(page);
  });

  test('所属先のワークスペースが閉じていても、組織の Wiki は作成・保存できる', async () => {
    const target = await createTarget({ closed: true });
    const page = await create(target);
    const response = await call(target, orgWikiUpdate, {
      page_id: page.id,
      read_version: 1,
      title: page.title,
      body_md: '更新',
    });
    expect(response.status).toBe(200);
    expect(await read(target, page.id)).toMatchObject({ body_md: '更新', version: 2 });
  });

  test('同じ版の並行保存は1件だけ通り、古い版からの保存では本文を変えない', async () => {
    const target = await createTarget();
    const page = await create(target);
    const responses = await Promise.all(
      ['先', '後'].map((body_md) =>
        call(target, orgWikiUpdate, { page_id: page.id, read_version: 1, title: page.title, body_md }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await errorCodeOf(responses.find((r) => r.status === 409)!)).toBe('conflict');
    const current = await read(target, page.id);
    const stale = await call(target, orgWikiUpdate, {
      page_id: page.id,
      read_version: 1,
      title: '古い題',
      body_md: '書きかけ',
    });
    expect(stale.status).toBe(409);
    expect(await read(target, page.id)).toEqual(current);
    const unchanged = await call(target, orgWikiUpdate, {
      page_id: page.id,
      read_version: 2,
      title: current.title,
      body_md: current.body_md,
    });
    expect(unchanged.status).toBe(200);
    expect(await read(target, page.id)).toEqual(current);
    const db = orgDb(env, target.organization.verified);
    const revisions = await db.rows(
      db.statement((q) =>
        q.selectFrom('wiki_page_revisions').select('version').where('page_id', '=', page.id).orderBy('version'),
      ),
    );
    expect(revisions.map((r) => r.version)).toEqual([1, 2]);
  });

  test('frontmatter の題、文字数の上限と10段までの階層を共通の規則で扱う', async () => {
    const target = await createTarget();
    const root = await create(target, { title: '', body_md: '---\ntitle: 共通の決まり\n---\n本文' });
    expect(root.title).toBe('共通の決まり');
    let parent = root.id;
    for (let depth = 2; depth <= 10; depth++) parent = (await create(target, { parent_id: parent })).id;
    const tooDeep = await call(target, orgWikiCreate, { parent_id: parent, title: '11段目', body_md: '' });
    expect(tooDeep.status).toBe(409);
    expect(await errorCodeOf(tooDeep)).toBe('conflict');
    for (const input of [{ title: '題'.repeat(101) }, { body_md: '文'.repeat(100001) }, { title: '' }]) {
      const response = await call(target, orgWikiCreate, { title: '題', body_md: '', ...input });
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
    }
  });

  test('ページの作成はアカウントごとに30回までで、31回目にページを増やさない', async () => {
    const target = await createTarget();
    for (let i = 0; i < 30; i++) await create(target);
    const denied = await call(target, orgWikiCreate, { title: '31回目', body_md: '' });
    expect(denied.status).toBe(429);
    expect(await errorCodeOf(denied)).toBe('rate_limited');
    const tree = await call(target, orgWikiTree);
    expect(((await tree.json()) as { pages: unknown[] }).pages).toHaveLength(30);
  });

  test('ページの保存はアカウントごとに30回までで、31回目に版を増やさない', async () => {
    const target = await createTarget();
    const page = await create(target);
    for (let i = 1; i <= 30; i++) {
      const saved = await call(target, orgWikiUpdate, {
        page_id: page.id,
        read_version: i,
        title: page.title,
        body_md: `第${i}回の保存`,
      });
      expect(saved.status).toBe(200);
    }
    const denied = await call(target, orgWikiUpdate, {
      page_id: page.id,
      read_version: 31,
      title: page.title,
      body_md: '31回目',
    });
    expect(denied.status).toBe(429);
    expect(await errorCodeOf(denied)).toBe('rate_limited');
    expect(await read(target, page.id)).toMatchObject({ body_md: '第30回の保存', version: 31 });
  });

  test('組織の容量の上限は作成と保存に適用され、断った保存は版も変えない', async () => {
    const target = await createTarget();
    const page = await create(target);
    const db = commonDb(env);
    await db.run(
      db.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: 1 }).where('id', '=', target.organization.id),
      ),
    );
    const denied = [
      await call(target, orgWikiCreate, { title: '題', body_md: '' }),
      await call(target, orgWikiUpdate, { page_id: page.id, read_version: 1, title: '題', body_md: '増やす本文' }),
    ];
    for (const response of denied) {
      expect(response.status).toBe(409);
      expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
    }
    expect(await read(target, page.id)).toEqual(page);
  });
});
