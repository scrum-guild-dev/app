import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiCreate, workspaceWikiCreate } from '../src/shared/operations/wiki/index.ts';
import type { WikiNode } from '../src/shared/operations/wiki/index.ts';
import { AT, createAttachment, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
type FileInput = { file_name: string; body_md: string };
const files = (count: number): FileInput[] =>
  Array.from({ length: count }, (_, index) => ({ file_name: `手順${index}.md`, body_md: `本文${index}` }));

for (const kind of ['organization', 'workspace'] as const) {
  const organization = kind === 'organization';
  // 呼び口だけを固定する。実装がまだ一覧に無い間も import エラーにせず、HTTP の失敗で検出する。
  const definition = {
    ...(organization ? orgWikiCreate : workspaceWikiCreate),
    name: organization ? 'org-wiki-upload' : 'workspace-wiki-upload',
  };
  function upload(target: Target, input: Record<string, unknown>, requestEnv?: Env) {
    return post(app, definition, {
      slug: target.slug,
      token: target.member.token,
      body: { ...(organization ? {} : { workspace_id: target.workspace.id }), ...input },
      env: requestEnv,
    });
  }
  async function rows(target: Target) {
    const db = orgDb(env, target.organization.verified);
    const pages = await db.rows(
      db.statement((q) => {
        const query = q.selectFrom('wiki_pages').selectAll();
        return organization
          ? query.where('organization_id', '=', target.organization.id)
          : query.where('workspace_id', '=', target.workspace.id);
      }),
    );
    const revisions = await db.rows(
      db.statement((q) => {
        const query = q
          .selectFrom('wiki_page_revisions')
          .innerJoin('wiki_pages', 'wiki_pages.id', 'wiki_page_revisions.page_id')
          .select([
            'wiki_page_revisions.page_id',
            'wiki_page_revisions.version',
            'wiki_page_revisions.title',
            'wiki_page_revisions.body_md',
            'wiki_page_revisions.saved_by',
          ]);
        return organization
          ? query.where('wiki_pages.organization_id', '=', target.organization.id)
          : query.where('wiki_pages.workspace_id', '=', target.workspace.id);
      }),
    );
    return { pages, revisions };
  }
  async function seed(target: Target, parent: string | null = null, scope = kind): Promise<string> {
    const db = orgDb(env, target.organization.verified);
    const id = uuidv7();
    await db.run(
      db.statement((q) =>
        q.insertInto('wiki_pages').values({
          id,
          organization_id: scope === 'organization' ? target.organization.id : null,
          workspace_id: scope === 'workspace' ? target.workspace.id : null,
          parent_id: parent,
          position: 'a0',
          title: '既存の親',
          body_md: '既存の本文',
          version: 1,
          created_by: target.member.userId!,
          updated_by: target.member.userId!,
          created_at: AT,
          updated_at: AT,
        }),
      ),
    );
    return id;
  }
  async function setQuota(target: Target, bytes: number) {
    const db = commonDb(env);
    await db.run(
      db.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: bytes }).where('id', '=', target.organization.id),
      ),
    );
  }
  async function rateCount(target: Target) {
    const db = commonDb(env);
    return (
      await db.first(
        db.statement((q) =>
          q
            .selectFrom('rate_limits')
            .select('count')
            .where('key', '=', `operation:${definition.name}:${target.member.accountId}`),
        ),
      )
    )?.count;
  }

  describe(`${kind}: Wiki の .md の一括取り込み`, () => {
    test('20件を最上段に入力順で新規作成し、それぞれの本文と第1版を残す', async () => {
      const target = await createTarget();
      const input = files(20);
      const response = await upload(target, { files: input });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { pages: WikiNode[] };
      expect(result.pages).toHaveLength(20);
      expect(result.pages.map((page) => page.title)).toEqual(input.map((file) => file.file_name.slice(0, -3)));
      expect(new Set(result.pages.map((page) => page.id)).size).toBe(20);
      expect(result.pages.every((page) => page.parent_id === null && page.version === 1)).toBe(true);
      expect(result.pages.map((page) => page.position)).toEqual(result.pages.map((page) => page.position).toSorted());
      expect(new Set(result.pages.map((page) => page.position)).size).toBe(20);
      const stored = await rows(target);
      expect(stored.pages).toHaveLength(20);
      expect(stored.revisions).toHaveLength(20);
      for (const [index, page] of result.pages.entries()) {
        expect(stored.pages.find((row) => row.id === page.id)).toMatchObject({
          title: page.title,
          body_md: input[index].body_md,
          created_by: target.member.userId,
          updated_by: target.member.userId,
        });
        expect(stored.revisions.find((row) => row.page_id === page.id)).toMatchObject({
          title: page.title,
          body_md: input[index].body_md,
          version: 1,
          saved_by: target.member.userId,
        });
      }
      expect(await rateCount(target)).toBe(20);
    });

    test('選んだ親の下へ足し、同じ題でも既存ページを上書きしない', async () => {
      const target = await createTarget();
      const parent = await seed(target);
      const input = { files: [{ file_name: '同じ題.md', body_md: '初めの本文' }], parent_id: parent };
      const first = await upload(target, input);
      expect(first.status).toBe(200);
      const second = await upload(target, { ...input, files: [{ file_name: '同じ題.md', body_md: '次の本文' }] });
      expect(second.status).toBe(200);
      const stored = await rows(target);
      const children = stored.pages.filter((page) => page.parent_id === parent);
      expect(children).toHaveLength(2);
      expect(children.map((page) => page.body_md).sort()).toEqual(['初めの本文', '次の本文'].sort());
      expect(children.every((page) => page.title === '同じ題' && page.version === 1)).toBe(true);
      expect(stored.revisions).toHaveLength(2);
    });

    test('frontmatter の題を優先し、無効な title と読めない YAML はファイル名へ戻す', async () => {
      const target = await createTarget();
      const bodies = [
        '---\ntitle: " 前書きの題 "\nother: 値\n---\n本文',
        '---\ntitle: 123\n---\n本文',
        '---\ntitle: "   "\n---\n本文',
        `---\ntitle: ${'題'.repeat(101)}\n---\n本文`,
        '---\ntitle: [\n---\n本文',
      ];
      const response = await upload(target, {
        files: bodies.map((body_md, index) => ({ file_name: `手順${index}.md`, body_md })),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { pages: WikiNode[] };
      expect(result.pages.map((page) => page.title)).toEqual(['前書きの題', '手順1', '手順2', '手順3', '手順4']);
      const stored = await rows(target);
      for (const [index, page] of result.pages.entries())
        expect(stored.pages.find((row) => row.id === page.id)?.body_md).toBe(bodies[index]);
    });

    test('本文10万字と題100字の上限をコードポイントで数える', async () => {
      const target = await createTarget();
      const response = await upload(target, {
        files: [{ file_name: `${'😀'.repeat(100)}.md`, body_md: '😀'.repeat(100000) }],
      });
      expect(response.status).toBe(200);
      const stored = await rows(target);
      expect(stored.pages).toHaveLength(1);
      expect([...stored.pages[0].title]).toHaveLength(100);
      expect([...stored.pages[0].body_md]).toHaveLength(100000);
    });

    test('正常な20ファイルがそれぞれ10万字でも取り込める', async () => {
      const target = await createTarget();
      const input = files(20).map((file) => ({ ...file, body_md: 'a'.repeat(100000) }));
      const response = await upload(target, { files: input });
      expect(response.status).toBe(200);
      const stored = await rows(target);
      expect(stored.pages).toHaveLength(20);
      expect(stored.revisions).toHaveLength(20);
      expect(stored.pages.every((page) => page.body_md.length === 100000)).toBe(true);
    });

    test('ファイル名255字は有効なfrontmatterの題があれば使える', async () => {
      const target = await createTarget();
      const response = await upload(target, {
        files: [{ file_name: `${'長'.repeat(252)}.md`, body_md: '---\ntitle: 手順\n---\n本文' }],
      });
      expect(response.status).toBe(200);
      expect((await rows(target)).pages[0].title).toBe('手順');
    });

    test.each([
      { file_name: '形式.txt', body_md: '本文' },
      { file_name: '大き過ぎる.md', body_md: '文'.repeat(100001) },
      { file_name: '.md', body_md: '本文' },
      { file_name: `${'題'.repeat(101)}.md`, body_md: '本文' },
      { file_name: 'NUL.md', body_md: '本文\0' },
      { file_name: 'UTF8.md', body_md: '\ud800' },
      { file_name: `${'長'.repeat(253)}.md`, body_md: '---\ntitle: 有効な題\n---\n本文' },
    ])('不正な1件を含む要求は全件拒否し、ファイルの位置と理由を返す: $file_name', async (invalid) => {
      const target = await createTarget();
      const response = await upload(target, { files: [files(1)[0], invalid, files(1)[0]] });
      expect(response.status).toBe(400);
      const error = (await response.json()) as {
        error: { code: string; details: { path: string; message: string }[] };
      };
      expect(error.error.code).toBe('invalid_input');
      expect(
        error.error.details.some((detail) => /^files\.1(?:\.|$)/.test(detail.path) && detail.message.length > 0),
      ).toBe(true);
      expect(await rows(target)).toEqual({ pages: [], revisions: [] });
      expect(await rateCount(target)).toBeUndefined();
    });

    test.each([0, 21])('ファイル%d件は全件拒否し、回数にも数えない', async (count) => {
      const target = await createTarget();
      const response = await upload(target, { files: files(count) });
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(await rows(target)).toEqual({ pages: [], revisions: [] });
      expect(await rateCount(target)).toBeUndefined();
    });

    test('不正なファイル2件の理由を両方返す', async () => {
      const target = await createTarget();
      const response = await upload(target, {
        files: [
          files(1)[0],
          { file_name: '形式.txt', body_md: '' },
          { file_name: '大き過ぎる.md', body_md: 'x'.repeat(100001) },
        ],
      });
      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: { details: { path: string; message: string }[] } };
      for (const index of [1, 2])
        expect(
          error.details.some((detail) => detail.path.startsWith(`files.${index}`) && detail.message.length > 0),
        ).toBe(true);
      expect(await rows(target)).toEqual({ pages: [], revisions: [] });
    });

    test('別の組織ともう一方のWikiの親は404で、取り込まない', async () => {
      const target = await createTarget();
      const foreign = await createTarget();
      const foreignParent = await seed(foreign);
      const otherWikiParent = await seed(target, null, organization ? 'workspace' : 'organization');
      for (const parent of [foreignParent, otherWikiParent, uuidv7()]) {
        const response = await upload(target, { files: files(2), parent_id: parent });
        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe('not_found');
      }
      expect(await rows(target)).toEqual({ pages: [], revisions: [] });
    });

    test('深さ10段の親の下には一部も作らず409で断る', async () => {
      const target = await createTarget();
      let parent: string | null = null;
      for (let depth = 1; depth <= 10; depth++) parent = await seed(target, parent);
      const response = await upload(target, { files: files(2), parent_id: parent });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'too_deep' } } });
      const stored = await rows(target);
      expect(stored.pages).toHaveLength(10);
      expect(stored.revisions).toHaveLength(0);
    });

    test('合算容量の残りへ1件だけ収まっても2件の要求全体を断る', async () => {
      const target = await createTarget();
      // 各ファイルは題aと本文b、最新と第1版で4 bytes。全件には8 bytes必要。
      await setQuota(target, 7);
      const response = await upload(target, {
        files: [
          { file_name: 'a.md', body_md: 'b' },
          { file_name: 'a.md', body_md: 'b' },
        ],
      });
      expect(response.status).toBe(409);
      expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
      expect(await rows(target)).toEqual({ pages: [], revisions: [] });
    });

    test('容量はUTF-8で題と本文の最新・版を合算し、ちょうどなら成功する', async () => {
      const target = await createTarget();
      await setQuota(target, 16); // (題3 + a1) × 最新と版 × 2ページ
      const response = await upload(target, {
        files: [
          { file_name: '題.md', body_md: 'a' },
          { file_name: '題.md', body_md: 'a' },
        ],
      });
      expect(response.status).toBe(200);
      expect((await rows(target)).pages).toHaveLength(2);
      expect((await rows(target)).revisions).toHaveLength(2);
    });

    test('同じ組織の別ワークスペースの添付容量を数え、他組織の容量は混ぜない', async () => {
      const target = await createTarget();
      const foreign = await createTarget();
      await createAttachment(foreign.organization, foreign.workspace.id, foreign.admin.userId!, { size_bytes: 999999 });
      await createAttachment(target.organization, target.otherWorkspace.id, target.admin.userId!, { size_bytes: 3 });
      await setQuota(target, 10); // 既存3 + 必要8 > 10
      const input = {
        files: [
          { file_name: 'a.md', body_md: 'b' },
          { file_name: 'a.md', body_md: 'b' },
        ],
      };
      const rejected = await upload(target, input);
      expect(rejected.status).toBe(409);
      expect(await errorCodeOf(rejected)).toBe('attachment_quota_exceeded');
      expect(await rows(target)).toEqual({ pages: [], revisions: [] });
      await setQuota(target, 11);
      expect((await upload(target, input)).status).toBe(200);
    });

    test('30件までは許可し、超えた要求もファイル数ぶん数えて一部も作らない', async () => {
      const target = await createTarget();
      expect((await upload(target, { files: files(20) })).status).toBe(200);
      expect((await upload(target, { files: files(9) })).status).toBe(200);
      expect(await rateCount(target)).toBe(29);
      const rejected = await upload(target, { files: files(2) });
      expect(rejected.status).toBe(429);
      expect(await errorCodeOf(rejected)).toBe('rate_limited');
      expect(await rateCount(target)).toBe(31);
      expect((await rows(target)).pages).toHaveLength(29);
      expect((await rows(target)).revisions).toHaveLength(29);
      expect((await upload(target, { files: files(1) })).status).toBe(429);
      expect(await rateCount(target)).toBe(32);
    });

    test('ファイル数ちょうど30件まで成功し、窓を過ぎると件数をNへ戻す', async () => {
      const target = await createTarget();
      expect((await upload(target, { files: files(20) })).status).toBe(200);
      expect((await upload(target, { files: files(10) })).status).toBe(200);
      expect(await rateCount(target)).toBe(30);
      const db = commonDb(env);
      await db.run(
        db.statement((q) =>
          q
            .updateTable('rate_limits')
            .set({ window_start_at: AT })
            .where('key', '=', `operation:${definition.name}:${target.member.accountId}`),
        ),
      );
      expect((await upload(target, { files: files(2) })).status).toBe(200);
      expect(await rateCount(target)).toBe(2);
    });

    test('Wikiの書き込みが失敗しても数えた重みは戻さない', async () => {
      const target = await createTarget();
      let interrupted = false;
      const hooked = envWithD1Hooks(env, {
        beforeBatch: (sqls) => {
          if (sqls.some((sql) => /insert\s+into\s+["`]?wiki_pages/i.test(sql))) {
            interrupted = true;
            throw new Error('テスト用の一括書き込み失敗');
          }
        },
      });
      const response = await upload(target, { files: files(2) }, hooked);
      expect(response.status).toBe(500);
      expect(interrupted).toBe(true);
      expect(await rateCount(target)).toBe(2);
      expect(await rows(target)).toEqual({ pages: [], revisions: [] });
    });

    if (!organization) {
      test('同じ組織の別ワークスペースの親でも404になる', async () => {
        const target = await createTarget();
        const db = orgDb(env, target.organization.verified);
        const parent = await seed(target);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('wiki_pages')
              .set({ workspace_id: target.otherWorkspace.id })
              .where('id', '=', parent)
              .where('workspace_id', '=', target.workspace.id),
          ),
        );
        const response = await upload(target, { files: files(2), parent_id: parent });
        expect(response.status).toBe(404);
        expect(await errorCodeOf(response)).toBe('not_found');
        expect(await rows(target)).toEqual({ pages: [], revisions: [] });
      });

      test('閉じたワークスペースでは書かず、重みにも数えない', async () => {
        const target = await createTarget({ closed: true });
        const response = await upload(target, { files: files(2) });
        expect(response.status).toBe(409);
        expect(await errorCodeOf(response)).toBe('workspace_closed');
        expect(await rows(target)).toEqual({ pages: [], revisions: [] });
        expect(await rateCount(target)).toBeUndefined();
      });
    }
  });
}
