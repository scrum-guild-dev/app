import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import {
  workspaceWikiCreate,
  workspaceWikiPage,
  workspaceWikiTree,
  workspaceWikiUpdate,
} from '../src/shared/operations/wiki/index.ts';
import { AT, createAttachment } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
type Page = {
  id: string;
  parent_id: string | null;
  position: string;
  title: string;
  body_md: string;
  version: number;
  created_at: string;
  updated_at: string;
};

function call(
  target: Target,
  definition: AnyOperationDefinition,
  input: Record<string, unknown>,
  person = target.member,
) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...input },
  });
}

async function create(
  target: Target,
  input: Record<string, unknown> = {},
  person: Person = target.member,
): Promise<Page> {
  const response = await call(target, workspaceWikiCreate, { title: '手順書', body_md: '本文', ...input }, person);
  expect(response.status).toBe(200);
  return ((await response.json()) as { page: Page }).page;
}

async function read(target: Target, pageId: string): Promise<Page> {
  const response = await call(target, workspaceWikiPage, { page_id: pageId });
  expect(response.status).toBe(200);
  return ((await response.json()) as { page: Page }).page;
}

async function revisions(target: Target, pageId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('wiki_page_revisions')
        .innerJoin('wiki_pages', 'wiki_pages.id', 'wiki_page_revisions.page_id')
        .select(['wiki_page_revisions.version', 'wiki_page_revisions.title', 'wiki_page_revisions.body_md'])
        .where('wiki_pages.workspace_id', '=', target.workspace.id)
        .where('wiki_pages.id', '=', pageId)
        .orderBy('wiki_page_revisions.version'),
    ),
  );
}

async function quota(target: Target, bytes: number) {
  const db = commonDb(env);
  await db.run(
    db.statement((q) =>
      q.updateTable('organizations').set({ attachment_quota_bytes: bytes }).where('id', '=', target.organization.id),
    ),
  );
}

describe('ワークスペースの Wiki', () => {
  test('メンバーが最上段と子を作れ、木は本文を返さず同じ URL のページを読める', async () => {
    const target = await createTarget();
    const root = await create(target);
    const child = await create(target, { parent_id: root.id, title: '子の手順', body_md: '# 子の本文' });
    expect(root.parent_id).toBeNull();
    expect(child.parent_id).toBe(root.id);
    expect(await read(target, child.id)).toEqual(child);
    const response = await call(target, workspaceWikiTree, {});
    expect(response.status).toBe(200);
    const { pages } = (await response.json()) as { pages: Record<string, unknown>[] };
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.id)).toEqual(expect.arrayContaining([root.id, child.id]));
    expect(pages.every((page) => !('body_md' in page))).toBe(true);
    expect(await revisions(target, root.id)).toEqual([{ version: 1, title: root.title, body_md: root.body_md }]);
  });

  test('作った人以外のメンバーが題と本文を保存でき、IDは変わらない', async () => {
    const target = await createTarget();
    const page = await create(target, {}, target.leader);
    const response = await call(target, workspaceWikiUpdate, {
      page_id: page.id,
      read_version: 1,
      title: '新しい手順',
      body_md: '更新した本文',
    });
    expect(response.status).toBe(200);
    expect(await read(target, page.id)).toMatchObject({
      id: page.id,
      title: '新しい手順',
      body_md: '更新した本文',
      version: 2,
    });
    expect(await revisions(target, page.id)).toEqual([
      { version: 1, title: page.title, body_md: page.body_md },
      { version: 2, title: '新しい手順', body_md: '更新した本文' },
    ]);
    const db = orgDb(env, target.organization.verified);
    const logs = await db.rows(
      db.statement((q) =>
        q.selectFrom('change_logs').select('id').where('organization_id', '=', target.organization.id),
      ),
    );
    const xp = await db.rows(
      db.statement((q) => q.selectFrom('xp_grants').select('id').where('workspace_id', '=', target.workspace.id)),
    );
    expect(logs).toHaveLength(0);
    expect(xp).toHaveLength(0);
  });

  test('frontmatter の有効な title は入力の無効な題より優先する', async () => {
    const target = await createTarget();
    const body = '---\ntitle: 定例会の手順\ncategory: チーム\n---\n# 本文';
    const page = await create(target, { title: '', body_md: body });
    expect(page.title).toBe('定例会の手順');
    expect(page.body_md).toBe(body);
  });

  test.each(['---\ntitle: [\n---\n本文', '---\ntitle: 123\n---\n本文', '---\ntitle: "   "\n---\n本文'])(
    '読めないか題が無効な frontmatter は入力の題に戻す: %s',
    async (body) => {
      const target = await createTarget();
      const page = await create(target, { title: ' 入力の題 ', body_md: body });
      expect(page.title).toBe('入力の題');
      expect(page.body_md).toBe(body);
    },
  );

  test('題と本文の上限は UTF-16 の長さではなくコードポイントで数える', async () => {
    const target = await createTarget();
    const page = await create(target, { title: '😀'.repeat(100), body_md: '😀'.repeat(100000) });
    expect(Array.from(page.title)).toHaveLength(100);
    expect(Array.from(page.body_md)).toHaveLength(100000);
  });

  test.each([
    { title: '' },
    { title: ' '.repeat(4) },
    { title: '題'.repeat(101) },
    { body_md: '文'.repeat(100001) },
    { title: '題\0' },
    { body_md: '本文\0' },
  ])('無効な題か本文は理由を返して保存しない', async (input) => {
    const target = await createTarget();
    const response = await call(target, workspaceWikiCreate, { title: '手順', body_md: '本文', ...input });
    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('invalid_input');
    const tree = await call(target, workspaceWikiTree, {});
    expect((await tree.json()) as unknown).toMatchObject({ pages: [] });
  });

  test('10段までは作れ、11段目は作らず conflict になる', async () => {
    const target = await createTarget();
    let parent: string | null = null;
    for (let depth = 1; depth <= 10; depth++) parent = (await create(target, { parent_id: parent })).id;
    const response = await call(target, workspaceWikiCreate, { parent_id: parent, title: '11段目', body_md: '' });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('conflict');
    const tree = await call(target, workspaceWikiTree, {});
    expect(((await tree.json()) as { pages: unknown[] }).pages).toHaveLength(10);
  });

  test('同じ版の並行保存は1件だけ成功し、版の主キー違反を返さない', async () => {
    const target = await createTarget();
    const page = await create(target);
    const inputs = ['先の本文', '後の本文'];
    const responses = await Promise.all(
      inputs.map((body) =>
        call(target, workspaceWikiUpdate, { page_id: page.id, read_version: 1, title: page.title, body_md: body }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(await errorCodeOf(loser)).toBe('conflict');
    const current = await read(target, page.id);
    expect(current.version).toBe(2);
    expect(inputs).toContain(current.body_md);
    expect(await revisions(target, page.id)).toHaveLength(2);
  });

  test('本文と題が同じ保存では新しい版を作らない', async () => {
    const target = await createTarget();
    const page = await create(target);
    const response = await call(target, workspaceWikiUpdate, {
      page_id: page.id,
      read_version: 1,
      title: page.title,
      body_md: page.body_md,
    });
    expect(response.status).toBe(200);
    expect((await read(target, page.id)).version).toBe(1);
    expect(await revisions(target, page.id)).toHaveLength(1);
  });

  test('101版目を保存すると新しい100版だけを残す', async () => {
    const target = await createTarget();
    const page = await create(target);
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('wiki_pages')
          .set({ version: 100 })
          .where('id', '=', page.id)
          .where('workspace_id', '=', target.workspace.id),
      ),
      ...Array.from({ length: 99 }, (_, index) =>
        db.statement((q) =>
          q.insertInto('wiki_page_revisions').values({
            page_id: page.id,
            version: index + 2,
            title: page.title,
            body_md: page.body_md,
            saved_by: target.member.userId!,
            saved_at: AT,
          }),
        ),
      ),
    ]);
    const response = await call(target, workspaceWikiUpdate, {
      page_id: page.id,
      read_version: 100,
      title: page.title,
      body_md: '101版目',
    });
    expect(response.status).toBe(200);
    const kept = await revisions(target, page.id);
    expect(kept).toHaveLength(100);
    expect(kept[0]!.version).toBe(2);
    expect(kept.at(-1)).toMatchObject({ version: 101, body_md: '101版目' });
  });

  test('別のワークスペースと組織のページは読み取り・更新・親の指定すべて404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignPage = await create(foreign);
    const otherPage = await create({ ...target, workspace: target.otherWorkspace }, {}, target.admin);
    for (const page of [foreignPage, otherPage]) {
      for (const [operation, input] of [
        [workspaceWikiPage, { page_id: page.id }],
        [workspaceWikiUpdate, { page_id: page.id, read_version: 1, title: '不正な変更', body_md: '本文' }],
        [workspaceWikiCreate, { parent_id: page.id, title: '不正な子', body_md: '' }],
      ] as const) {
        const response = await call(target, operation, input);
        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe('not_found');
      }
    }
  });

  test('ワークスペースに属さない人はページを読めない', async () => {
    const target = await createTarget();
    const page = await create(target);
    const response = await call(target, workspaceWikiPage, { page_id: page.id }, target.bystander);
    expect(response.status).toBe(404);
  });

  test('削除したページは本文を保持していても木・読み取り・保存・親の指定から隠す', async () => {
    const target = await createTarget();
    const page = await create(target);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('wiki_pages')
          .set({ deleted_at: AT, deleted_by: target.member.userId! })
          .where('workspace_id', '=', target.workspace.id)
          .where('id', '=', page.id),
      ),
    );
    const tree = await call(target, workspaceWikiTree, {});
    expect((await tree.json()) as unknown).toMatchObject({ pages: [] });
    for (const [operation, input] of [
      [workspaceWikiPage, { page_id: page.id }],
      [workspaceWikiUpdate, { page_id: page.id, read_version: 1, title: page.title, body_md: '変更' }],
      [workspaceWikiCreate, { parent_id: page.id, title: '子', body_md: '' }],
    ] as const)
      expect((await call(target, operation, input)).status).toBe(404);
    expect(await revisions(target, page.id)).toHaveLength(1);
  });

  test('閉じたワークスペースは読めるが作成と保存は拒否する', async () => {
    const target = await createTarget();
    const page = await create(target);
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: AT })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );
    expect((await call(target, workspaceWikiTree, {})).status).toBe(200);
    expect((await read(target, page.id)).id).toBe(page.id);
    for (const [operation, input] of [
      [workspaceWikiCreate, { title: '手順', body_md: '' }],
      [workspaceWikiUpdate, { page_id: page.id, read_version: 1, title: '手順', body_md: '変更' }],
    ] as const) {
      const response = await call(target, operation, input);
      expect(response.status).toBe(409);
      expect(await errorCodeOf(response)).toBe('workspace_closed');
    }
  });

  test('本文はUTF-8のバイト数で最新本文と版の両方を添付容量に算入する', async () => {
    const target = await createTarget();
    await quota(target, 11);
    const response = await call(target, workspaceWikiCreate, { title: '題', body_md: '日本' });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
    expect((await call(target, workspaceWikiTree, {})).status).toBe(200);
  });

  test('他ワークスペースの添付ファイルも容量に数え、他組織の容量は混ぜない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    await createAttachment(foreign.organization, foreign.workspace.id, foreign.admin.userId!, { size_bytes: 10000 });
    await createAttachment(target.organization, target.otherWorkspace.id, target.admin.userId!, { size_bytes: 9 });
    await quota(target, 10);
    const response = await call(target, workspaceWikiCreate, { title: '題', body_md: 'ab' });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
  });

  test('削除後保持中の本文と版も容量に数え、失敗した保存は本文も版も変えない', async () => {
    const target = await createTarget();
    const deleted = await create(target, { body_md: 'abc' });
    const page = await create(target, { body_md: 'x' });
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('wiki_pages')
          .set({ deleted_at: AT, deleted_by: target.member.userId! })
          .where('workspace_id', '=', target.workspace.id)
          .where('id', '=', deleted.id),
      ),
    );
    await quota(target, 10);
    const response = await call(target, workspaceWikiUpdate, {
      page_id: page.id,
      read_version: 1,
      title: page.title,
      body_md: 'xxxx',
    });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
    expect(await read(target, page.id)).toEqual(page);
    expect(await revisions(target, page.id)).toHaveLength(1);
  });

  test('容量ぎりぎりの並行作成でも合計上限を超えない', async () => {
    const target = await createTarget();
    await quota(target, 20);
    const responses = await Promise.all(
      ['a', 'b'].map((suffix) => call(target, workspaceWikiCreate, { title: `題${suffix}`, body_md: 'abc' })),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const tree = await call(target, workspaceWikiTree, {});
    expect(((await tree.json()) as { pages: unknown[] }).pages).toHaveLength(1);
  });
});
