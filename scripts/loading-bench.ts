// pnpm bench:loading [--runs 20] [--port 9742]。本番・既存のローカル D1 は使わない。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { operations } from '../src/shared/operations/index.ts';
import { isOutsideOperation } from '../src/shared/operations/define.ts';
import { loadingFixtureSql } from './loading-fixture.ts';
import { screens, type Reading } from './loading-screens.ts';
import { comparison, percentile, trialTiming } from './loading-stats.ts';
import { sessionInserts } from './seed.ts';
import { parallelRead } from './loading-order.ts';

function option(name: string, fallback: number, max: number): number {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`${name} が範囲外です`);
  return value;
}
const runs = option('--runs', 20, 10000);
const port = option('--port', 9742, 65534);
const origin = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'scrum-guild-loading-'));
// 秘密の設定ファイルを探索しないよう、一時ディレクトリに独立した wrangler 設定を作る。
const root = process.cwd();
const config = path.join(dir, 'wrangler.json');
const version = `loading-bench-${randomUUID()}`;
writeFileSync(
  config,
  JSON.stringify({
    name: 'loading-bench',
    main: path.join(root, 'src/server/index.ts'),
    compatibility_date: '2026-10-01',
    send_metrics: false,
    vars: {
      PUBLIC_ORIGIN: origin,
      APP_VERSION: version,
      OPERATOR_LOGIN_IDS: SEED_OPERATOR_LOGIN_ID,
      CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ 1: Buffer.alloc(32).toString('base64') }),
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'loading-bench',
        database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: path.join(root, 'migrations'),
      },
    ],
    r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'loading-bench' }],
  }),
);
let server: ReturnType<typeof spawn> | undefined;
let tracked: ReturnType<typeof trackServer> | undefined;
let interrupted = false;
const stop = () => {
  interrupted = true;
  tracked?.interrupt();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
function command(args: string[]) {
  if (interrupted) throw new Error('計測を中断しました');
  const result = spawnSync('wrangler', [...args, '--config', config, '--local', '--persist-to', dir], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0)
    throw new Error(`wrangler ${args.slice(0, 2).join(' ')} が失敗しました: ${result.stderr}`);
  return result.stdout;
}
async function call(reading: Reading, operator: boolean) {
  if (interrupted) throw new Error('計測を中断しました');
  const definition = operations.find((op) => op.name === reading.name);
  if (
    !definition ||
    definition.mode !== 'read' ||
    isOutsideOperation(definition) !== reading.global ||
    !definition.input.safeParse(reading.input).success
  )
    throw new Error(`${reading.name}: 計測表の操作または入力が不正`);
  const started = performance.now();
  const response = await fetch(`${origin}/api/${reading.global ? '' : 'aoba/'}${reading.name}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: `${sessionCookieName(origin)}=${operator ? SEED_SESSIONS.operator.token : SEED_SESSIONS.admin.token}`,
    },
    body: JSON.stringify(reading.input),
    signal: AbortSignal.timeout(30000),
  });
  const body: unknown = await response.json();
  const ms = performance.now() - started;
  if (!response.ok || !definition.output.safeParse(body).success)
    throw new Error(`${reading.name}: HTTP ${response.status} または応答の形が不正`);
  return { ms, finishedAt: started + ms, secondary: reading.secondary };
}
try {
  console.log(`使い捨て D1: ${dir}（終了時に削除）`);
  command(['d1', 'migrations', 'apply', 'DB']);
  // 空の D1 なので既存行の削除は不要。seed の固定行と期限付きセッションを入れる。
  const file = path.join(dir, 'fixture.sql');
  writeFileSync(
    file,
    readFileSync(path.join(root, 'seed/data.sql'), 'utf8') +
      sessionInserts(Object.values(SEED_SESSIONS), new Date()) +
      loadingFixtureSql(),
  );
  command(['d1', 'execute', 'DB', '--file', file]);
  server = spawn(
    'wrangler',
    [
      'dev',
      '--config',
      config,
      '--local',
      '--persist-to',
      dir,
      '--port',
      String(port),
      '--inspector-port',
      String(port + 1),
    ],
    { stdio: 'ignore', cwd: dir, detached: process.platform !== 'win32' },
  );
  tracked = trackServer(server, process.platform !== 'win32');
  for (let i = 0; ; i++) {
    if (interrupted || tracked.stopped || i >= 120) throw new Error('計測サーバーが立ち上がりません');
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok && isBenchHealth(await res.json(), version)) break;
    } catch {
      /* 起動を待つ */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(
    `Node ${process.version}、各画面・発行順ごと warmup 2 回 + ${runs} 回（正順・逆順）。時間は API 往復 ms。分位点は nearest-rank。`,
  );
  console.log('| load | 操作（主/従） | p50 ms | p95 ms |');
  console.log('| --- | --- | ---: | ---: |');
  for (const screen of screens) {
    if (!screen.operations.length) {
      console.log(`| ${screen.route} | 操作なし | — | — |`);
      continue;
    }
    const operations = [...screen.operations, ...(screen.after ?? [])];
    const orderTrials = [];
    for (const reverse of [false, true]) {
      const label = reverse ? '逆順' : '正順';
      const read = async () => {
        const started = performance.now();
        const first = await parallelRead(screen.operations, reverse, (op) => call(op, screen.operator ?? false));
        const after = await parallelRead(screen.after ?? [], reverse, (op) => call(op, screen.operator ?? false));
        return [...first, ...after].map((o) => ({ ...o, completedMs: o.finishedAt - started }));
      };
      await read();
      await read();
      const samples = [];
      for (let i = 0; i < runs; i++) samples.push(await read());
      for (const [index, op] of operations.entries()) {
        const values = samples.map((sample) => sample[index]!.ms);
        console.log(
          `| ${screen.route} | ${label}: ${op.name}（${op.secondary ? '従' : '主'}） | ${percentile(values, 0.5).toFixed(2)} | ${percentile(values, 0.95).toFixed(2)} |`,
        );
      }
      const trials = samples.map((sample) =>
        trialTiming(sample.map((o) => ({ ms: o.completedMs, secondary: o.secondary }))),
      );
      orderTrials.push(trials);
      const result = comparison(trials);
      console.log(
        `| ${screen.route} | ${label}: 合計（各試行の最終完了） | ${percentile(
          trials.map((t) => t.total),
          0.5,
        ).toFixed(2)} | ${percentile(
          trials.map((t) => t.total),
          0.95,
        ).toFixed(2)} |`,
      );
      console.log(
        `| ${screen.route} | ${label}: 短縮見込み | ${result.p50Saving.toFixed(2)} | ${result.p95Saving.toFixed(2)} |`,
      );
    }
    const candidate = comparison(orderTrials[0]!, orderTrials[1]!).candidate;
    console.log(`| ${screen.route} | 後回しの判定（両順）: ${candidate ? '候補' : 'なし'} | — | — |`);
    if (screen.note) console.log(`\n${screen.route}: ${screen.note}\n`);
  }
} finally {
  await tracked?.stop();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  rmSync(dir, { recursive: true, force: true });
  console.log(`削除済み: ${dir}`);
}
