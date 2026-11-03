// 使い捨てのローカル D1 と実際の検索 API で測る。本番と開発中の D1 は使わない。
// pnpm exec node scripts/wiki-search-bench.ts（先に scripts/prepare.ts）。結果は docs/data-model.md。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';

const origin = 'http://localhost:9702';
const orgId = '019a0000-0000-7000-8000-000000000201';
const userId = '019a0000-0000-7000-8000-000000000301';
const workspaceId = '019b7570-0000-7000-8000-000000000001';
const dir = mkdtempSync(path.join(tmpdir(), 'wiki-search-bench-'));
const persist = ['--local', '--persist-to', dir];
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error || result.status !== 0) throw new Error(`${command} が失敗しました`);
}
function execute(sql: string) {
  const file = path.join(dir, 'wiki.sql');
  writeFileSync(file, sql);
  run('wrangler', ['d1', 'execute', 'DB', ...persist, '--file', file]);
}
async function call(query: string, org: boolean) {
  const start = performance.now();
  const response = await fetch(`${origin}/api/aoba/${org ? 'org' : 'workspace'}-wiki-search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: `${sessionCookieName(origin)}=${SEED_SESSIONS.admin.token}`,
    },
    body: JSON.stringify(org ? { query } : { workspace_id: workspaceId, query }),
    signal: AbortSignal.timeout(5000),
  });
  const data = (await response.json()) as { pages?: unknown[] };
  if (!response.ok || !data.pages) throw new Error(`検索が失敗しました: ${response.status}`);
  return { ms: performance.now() - start, count: data.pages.length };
}
let server: ReturnType<typeof spawn> | undefined;
try {
  run('node', ['scripts/db-seed.ts', '--persist-to', dir]);
  execute(`INSERT INTO workspaces(id, organization_id, name, timezone, vocabulary, created_by, created_at, updated_at)
    VALUES ('${workspaceId}', '${orgId}', '検索の測定', 'Asia/Tokyo', 'scrum', '${userId}', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z');`);
  server = spawn(
    'wrangler',
    [
      'dev',
      '--local',
      '--port',
      '9702',
      '--inspector-port',
      '9703',
      '--persist-to',
      dir,
      '--var',
      `PUBLIC_ORIGIN:${origin}`,
    ],
    { stdio: 'ignore' },
  );
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      ready = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* 起動待ち */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('wrangler dev が立ち上がりません');
  // 走査する本文は各 Wiki で最大300 MBまで。応答5秒で打ち切り、これ以上のデータへ増やさない。
  // 目安はAPI中央値500ms以下・最大2秒以下。超えれば実運用の分布を測り直す。
  const lastMeasurement = new Map<boolean, number>();
  for (const [count, length] of [
    [5000, 2000],
    [1000, 100000],
  ] as const) {
    for (const org of [false, true]) {
      execute(`DELETE FROM wiki_pages WHERE ${org ? `organization_id = '${orgId}'` : `workspace_id = '${workspaceId}'`};
        INSERT INTO wiki_pages(id, organization_id, workspace_id, parent_id, position, title, body_md, version, created_by, updated_by, created_at, updated_at)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${count})
        SELECT printf('019b757${org ? 1 : 0}-0000-7000-8000-%012d', i), ${org ? `'${orgId}', NULL` : `NULL, '${workspaceId}'`}, NULL, 'a0',
          CASE WHEN i % 100 = 0 THEN '検索対象 手順' ELSE '普通の題' END,
          substr(replace(hex(zeroblob(${length})), '0', '文'), 1, ${length - 18}) || ' 共通語 手順 本文 末尾 検索対象',
          1, '${userId}', '${userId}', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z' FROM n;`);
      const cooldown = Math.max(0, (lastMeasurement.get(org) ?? 0) + 61000 - Date.now());
      if (cooldown) {
        console.log(`検索の回数制限の窓が変わるまで${Math.ceil(cooldown / 1000)}秒待ちます`);
        await new Promise((resolve) => setTimeout(resolve, cooldown));
      }
      lastMeasurement.set(org, Date.now());
      for (const query of ['検索対象', '不存在', '共通語 手順 本文 末尾 検索対象']) {
        await call(query, org);
        const times: number[] = [];
        let hits = 0;
        for (let i = 0; i < 9; i++) {
          const result = await call(query, org);
          times.push(result.ms);
          hits = result.count;
        }
        times.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            org,
            pages: count,
            bodyChars: length,
            query,
            hits,
            medianMs: Math.round(times[4]!),
            maxMs: Math.round(times.at(-1)!),
          }),
        );
      }
    }
  }
} finally {
  server?.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
