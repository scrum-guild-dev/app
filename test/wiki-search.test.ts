import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb, searchWikiPages } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { orgWikiSearch, workspaceWikiSearch } from '../src/shared/operations/wiki/index.ts';
import { envWithD1Hooks, runStatementsForTest } from '../src/server/db/testing.ts';
import { AT, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);
async function add(
  target: Target,
  title: string,
  body_md: string,
  options: { org?: boolean; deleted?: boolean; at?: string } = {},
) {
  const db = orgDb(env, target.organization.verified);
  const id = uuidv7();
  await db.run(
    db.statement((q) =>
      q.insertInto('wiki_pages').values({
        id,
        organization_id: options.org ? target.organization.id : null,
        workspace_id: options.org ? null : target.workspace.id,
        parent_id: null,
        position: 'a0',
        title,
        body_md,
        version: 1,
        created_by: target.admin.userId!,
        updated_by: target.admin.userId!,
        created_at: AT,
        updated_at: options.at ?? AT,
        deleted_at: options.deleted ? AT : null,
        deleted_by: options.deleted ? target.admin.userId! : null,
      }),
    ),
  );
  return id;
}
async function search(target: Target, query: string, org = false) {
  return post(app, org ? orgWikiSearch : workspaceWikiSearch, {
    slug: target.slug,
    token: target.member.token,
    body: org ? { query } : { workspace_id: target.workspace.id, query },
  });
}

describe.each([false, true])('Wiki の検索（組織: %s）', (org) => {
  test('題と本文にまたがる全語を探し、全語が題にあるもの・更新の新しいものを先に返す', async () => {
    const target = await createTarget();
    const old = await add(target, 'Release 手順', '', { org });
    const newer = await add(target, '手順 RELEASE', '', { org, at: '2026-11-04T00:00:00.000Z' });
    const mixed = await add(target, '手順', 'release の本文', { org, at: '2026-11-05T00:00:00.000Z' });
    const body = await add(target, '別の題', '---\ntags: [release, 手順]\n---', { org });
    await add(target, 'release だけ', '手引き', { org });
    const response = await search(target, '  RELEASE　手順 ', org);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pages: [
        { id: newer, title: '手順 RELEASE', matched_in: 'title' },
        { id: old, title: 'Release 手順', matched_in: 'title' },
        { id: mixed, title: '手順', matched_in: 'title' },
        { id: body, title: '別の題', matched_in: 'body' },
      ],
    });
  });

  test('削除・他のWiki・他組織を混ぜず、語をページ間でそろえない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    await add(target, '検索語', '本文', { org, deleted: true });
    await add(target, '検索語', '本文', { org: !org });
    await add({ ...target, workspace: target.otherWorkspace }, '検索語', '本文');
    await add(foreign, '検索語', '本文', { org });
    await add(target, '検索語', '', { org });
    await add(target, '本文', '', { org });
    const response = await search(target, '検索語 本文', org);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pages: [] });
  });

  test.each(['', ' 　\t ', 'a b c d e f', '語'.repeat(101)])('空の語や上限超過を400にする: %s', async (query) => {
    const target = await createTarget();
    const response = await search(target, query, org);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  test('5,000ページまでは検索し、5,001ページは本文を検索せず断る', async () => {
    const target = await createTarget();
    await seedMany(target, org, 5000, "''");
    expect((await search(target, '不在', org)).status).toBe(200);
    await add(target, '追加', '', { org });
    const response = await search(target, '不在', org);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'wiki_search_limit' } });
  });

  test('32MiBを超える本文は検索せず断り、削除したページは量に含めない', async () => {
    const target = await createTarget();
    await seedMany(target, org, 111, "replace(hex(zeroblob(50000)), '0', '文')");
    // 111 × (本文300,000B + 題3B) + 3 × 題3B + 本文254,090B = 32MiBちょうど。
    for (const size of [100000, 100000, 54090]) await add(target, '端', 'x'.repeat(size), { org });
    expect((await search(target, '不在', org)).status).toBe(200);
    const extra = await add(target, 'x', '', { org });
    const response = await search(target, '不在', org);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'wiki_search_limit' } });
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('wiki_pages')
          .set({ deleted_at: AT, deleted_by: target.admin.userId! })
          .where('id', '=', extra)
          .where(org ? 'organization_id' : 'workspace_id', '=', org ? target.organization.id : target.workspace.id),
      ),
    );
    expect((await search(target, '不在', org)).status).toBe(200);
  });

  test('他のWikiの5,001ページは検索予算に混ぜない', async () => {
    const target = await createTarget();
    await seedMany(target, !org, 5001, "''");
    const id = await add(target, '自分の題', '', { org });
    expect(await (await search(target, '自分', org)).json()).toEqual({
      pages: [{ id, title: '自分の題', matched_in: 'title' }],
    });
  });

  test('検索の31回目を429で断る', async () => {
    const target = await createTarget();
    for (let i = 0; i < 30; i++) expect((await search(target, '語', org)).status).toBe(200);
    const response = await search(target, '語', org);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  test('記号を文字として探し、全半角・Unicode正規化を変えず、50件で打ち切る', async () => {
    const target = await createTarget();
    const exact = await add(target, '%_\\ café Ａ', '', { org });
    await add(target, 'wildcard cafe\u0301 A', '', { org });
    expect(await (await search(target, '%_\\ café Ａ', org)).json()).toEqual({
      pages: [{ id: exact, title: '%_\\ café Ａ', matched_in: 'title' }],
    });
    // 操作の作成回数制限とは独立に、同じ日時の51行で件数と安定した順序を確かめる。
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push(await add(target, '対象'.repeat(50), 'a b c d e', { org }));
    expect(await (await search(target, 'a b c d e', org)).json()).toEqual({
      pages: ids
        .sort()
        .slice(0, 50)
        .map((id) => ({ id, title: '対象'.repeat(50), matched_in: 'body' })),
    });
  });
});

async function seedMany(target: Target, org: boolean, count: number, bodySql: string) {
  const prefix = uuidv7().slice(0, 24);
  await runStatementsForTest(env, [
    `
    INSERT INTO wiki_pages(id, organization_id, workspace_id, parent_id, position, title, body_md, version, created_by, updated_by, created_at, updated_at)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${count})
    SELECT '${prefix}' || printf('%012d', i), ${org ? `'${target.organization.id}', NULL` : `NULL, '${target.workspace.id}'`}, NULL, 'a0', '題', ${bodySql}, 1,
      '${target.admin.userId}', '${target.admin.userId}', '${AT}', '${AT}' FROM n;
  `,
  ]);
}

test('閉じたワークスペースのWikiも検索できる', async () => {
  const target = await createTarget();
  const id = await add(target, '手順', '本文');
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
  expect(await (await search(target, '本文')).json()).toEqual({ pages: [{ id, title: '手順', matched_in: 'body' }] });
});

test('予算超過では検索本文を走査せず、予算の行読みも5,001行で打ち切る', async () => {
  const target = await createTarget();
  await seedMany(target, false, 10001, "'本文'");
  let rowsRead = 0;
  const measured = envWithD1Hooks(env, {
    afterQuery: async (_sql, meta) => {
      rowsRead += meta.rows_read;
    },
  });
  const result = await searchWikiPages(
    orgDb(measured, target.organization.verified),
    { workspaceId: target.workspace.id },
    '当たらない 語 五 つ 全部',
  );
  expect(result).toEqual({ limited: true, pages: [] });
  // 予算の読み取りは5,001行まで。CASEか予算のLIMITが無ければこの件数を超える。
  expect(rowsRead).toBeGreaterThan(0);
  expect(rowsRead).toBeLessThanOrEqual(5010);
});
