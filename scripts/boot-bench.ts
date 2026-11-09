// pnpm bench:boot [--runs 2] [--network fast|slow|both] [--path /aoba] [--port 9744] [--output /tmp/boot.json]
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { sessionInserts } from './seed.ts';
import { isBenchHealth, trackServer } from './loading-server.ts';
import { percentile } from './loading-stats.ts';
import {
  assertBootHeading,
  bootFailureSummary,
  bootNetworks,
  bootTiming,
  bootTransfers,
  type BootResource,
} from './boot-metrics.ts';
import { bootProxy } from './boot-proxy.ts';

type BootSample = ReturnType<typeof bootTiming> &
  ReturnType<typeof bootTransfers> & {
    profile: keyof typeof bootNetworks;
    run: number;
    responseEndMs: number;
    domReadyMs: number;
    afterDomReadyMs: number;
    completedAtDisplay: ReturnType<typeof bootTransfers>;
    resources: (BootResource & { finishedAtMs: number })[];
  };

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} の値がありません`);
  return value;
}
const runs = Number(option('--runs', '2'));
const port = Number(option('--port', '9744'));
const route = option('--path', '/aoba');
const expectedHeading = option('--heading', route === '/aoba' ? '今日やること' : '');
if (!expectedHeading.trim()) throw new Error('/aoba以外は --heading に目的の画面のh1の文字を指定してください');
const network = option('--network', 'both');
const output = option('--output', path.join(tmpdir(), `scrum-guild-boot-${Date.now()}.json`));
if (
  !Number.isSafeInteger(runs) ||
  runs < 1 ||
  runs > 100 ||
  !Number.isSafeInteger(port) ||
  port < 1024 ||
  port > 65532 ||
  !['fast', 'slow', 'both'].includes(network) ||
  !route.startsWith('/') ||
  route.startsWith('//') ||
  /[\\?#]/.test(route)
) {
  throw new Error('引数が不正です（runs:1〜100、port:1024〜65532、network:fast/slow/both、path:自分の画面のパス）');
}
const root = process.cwd();
const origin = `http://127.0.0.1:${port}`;
if (new URL(route, origin).origin !== origin || route.startsWith('/api'))
  throw new Error('画面のパスだけを指定してください');
const dir = mkdtempSync(path.join(tmpdir(), 'scrum-guild-boot-'));
const config = path.join(dir, 'wrangler.json');
const version = `boot-bench-${randomUUID()}`;
const env = {
  ...process.env,
  APP_VERSION: version,
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  WRANGLER_LOG_PATH: path.join(dir, 'wrangler.log'),
  WRANGLER_SEND_METRICS: 'false',
};
let tracked: ReturnType<typeof trackServer> | undefined;
let browser: Browser | undefined;
const proxy = bootProxy(port + 1);
let interrupted = false;
const stop = () => {
  interrupted = true;
  tracked?.interrupt();
  void browser?.close();
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
function command(bin: string, args: string[], cwd = root) {
  if (interrupted) throw new Error('計測を中断しました');
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0)
    throw new Error(`${bin} ${args.slice(0, 2).join(' ')} が失敗: ${result.stderr || result.error}`);
  return result.stdout;
}
function wrangler(args: string[]) {
  return command('wrangler', [...args, '--config', config, '--local', '--persist-to', dir], dir);
}
try {
  console.log(`使い捨てD1: ${dir}。本番ビルドを作ります。`);
  command('pnpm', ['build']);
  writeFileSync(
    config,
    JSON.stringify({
      name: 'boot-bench',
      main: path.join(root, 'src/server/index.ts'),
      compatibility_date: '2026-10-01',
      send_metrics: false,
      assets: {
        directory: path.join(root, 'build'),
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api', '/api/*'],
      },
      vars: {
        PUBLIC_ORIGIN: origin,
        APP_VERSION: version,
        OPERATOR_LOGIN_IDS: SEED_OPERATOR_LOGIN_ID,
        CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ 1: Buffer.alloc(32).toString('base64') }),
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'boot-bench',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: path.join(root, 'migrations'),
        },
      ],
      r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'boot-bench' }],
    }),
  );
  wrangler(['d1', 'migrations', 'apply', 'DB']);
  const fixture = path.join(dir, 'fixture.sql');
  writeFileSync(
    fixture,
    readFileSync(path.join(root, 'seed/data.sql'), 'utf8') + sessionInserts(Object.values(SEED_SESSIONS), new Date()),
  );
  wrangler(['d1', 'execute', 'DB', '--file', fixture]);
  const child = spawn(
    'wrangler',
    [
      'dev',
      '--config',
      config,
      '--local',
      '--persist-to',
      dir,
      '--port',
      String(port + 1),
      '--inspector-port',
      String(port + 2),
    ],
    {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  let serverLog = '';
  const capture = (chunk: Buffer) => {
    serverLog = (serverLog + chunk.toString()).slice(-8000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  tracked = trackServer(child, process.platform !== 'win32');
  for (let attempt = 0; ; attempt++) {
    if (interrupted || tracked.stopped || attempt >= 120)
      throw new Error(`計測サーバーが立ち上がりません: ${serverLog}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port + 1}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && isBenchHealth(await response.json(), version)) break;
    } catch {
      /* 起動を待つ */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', resolve);
  });
  browser = await chromium.launch({ headless: true });
  const samples: BootSample[] = [];
  const networks = network === 'both' ? (['fast', 'slow'] as const) : [network as keyof typeof bootNetworks];
  for (const profile of networks)
    for (let run = 1; run <= runs; run++) {
      if (interrupted) throw new Error('計測を中断しました');
      console.log(`${profile} ${run}/${runs}: ${route}`);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        serviceWorkers: 'block',
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        colorScheme: 'light',
      });
      try {
        await context.addCookies([{ name: sessionCookieName(origin), value: SEED_SESSIONS.admin.token, url: origin }]);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Performance.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          ...bootNetworks[profile],
          connectionType: 'cellular3g',
        });
        const pending = new Map<string, { url: string; type: string; gzip: boolean }>();
        const resources: (BootResource & { finishedTimestamp: number })[] = [];
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        cdp.on('Network.requestWillBeSent', ({ redirectResponse }) => {
          if (redirectResponse) errors.push(`想定外のリダイレクト: ${redirectResponse.status}`);
        });
        cdp.on('Network.responseReceived', ({ requestId, type, response }) => {
          if (new URL(response.url).origin !== origin) {
            errors.push('外部URLへの転送');
            return;
          }
          if (response.status >= 400 || response.fromDiskCache || response.fromServiceWorker)
            errors.push(`${response.status} ${new URL(response.url).pathname} またはキャッシュ`);
          pending.set(requestId, {
            url: new URL(response.url).pathname,
            type,
            gzip: Object.entries(response.headers).some(
              ([key, value]) => key.toLowerCase() === 'content-encoding' && value === 'gzip',
            ),
          });
        });
        cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength, timestamp }) => {
          const resource = pending.get(requestId);
          if (resource) {
            resources.push({
              ...resource,
              bytes: encodedDataLength,
              finishedTimestamp: timestamp,
            });
            pending.delete(requestId);
          }
        });
        cdp.on('Network.loadingFailed', ({ errorText }) => errors.push(errorText));
        await page.addInitScript(() => {
          localStorage.setItem('sg-theme', 'simple_light');
          const state = { seen: false, shownMs: 0, failedAtMs: null as number | null };
          Object.assign(window, { __bootBench: state });
          // CSSの15秒タイマーの開始はHTMLのresponseStartと同時とは限らない。実際のvisibilityを観測する。
          const observe = () => {
            const boot = document.getElementById('boot-loading');
            if (boot) {
              state.seen = true;
              const failed = boot.querySelector('.boot-failed');
              if (
                failed &&
                getComputedStyle(failed).visibility === 'visible' &&
                getComputedStyle(boot).visibility === 'visible' &&
                state.failedAtMs === null
              )
                state.failedAtMs = performance.now();
            } else if (state.seen && document.querySelector('#app h1')) {
              state.shownMs = performance.now();
              return;
            }
            requestAnimationFrame(observe);
          };
          requestAnimationFrame(observe);
        });
        await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForFunction(
          () => (window as unknown as { __bootBench: { shownMs: number } }).__bootBench.shownMs > 0,
          {},
          { timeout: 180000 },
        );
        const timing = await page.evaluate(() => ({
          responseStart: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseStart,
          responseEnd: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseEnd,
          domReadyMs: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)
            .domContentLoadedEventEnd,
          observation: (window as unknown as { __bootBench: import('./boot-metrics.ts').BootObservation }).__bootBench,
        }));
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForLoadState('networkidle', { timeout: 180000 });
        const { metrics } = await cdp.send('Performance.getMetrics');
        const navigationStart = metrics.find((metric) => metric.name === 'NavigationStart')?.value;
        if (navigationStart === undefined || !Number.isFinite(navigationStart) || navigationStart <= 0) {
          throw new Error('CDPのナビゲーション開始時刻を取得できません');
        }
        const completedResources = resources.map(({ finishedTimestamp, ...resource }) => ({
          ...resource,
          finishedAtMs: (finishedTimestamp - navigationStart) * 1000,
        }));
        if (new URL(page.url()).pathname !== route) errors.push('目的のURLを表示できませんでした');
        assertBootHeading(await page.locator('#app h1').allTextContents(), expectedHeading);
        if (pending.size) errors.push('転送が完了していません');
        if (
          !resources.some((r) => r.type === 'Document' && r.gzip) ||
          !resources.some((r) => r.type === 'Stylesheet' && r.gzip) ||
          !resources.some((r) => r.type === 'Script' && r.gzip)
        )
          errors.push('HTML/CSS/JSのgzip配信を確認できません');
        if (errors.length) throw new Error(`計測失敗: ${errors.join(', ')}`);
        samples.push({
          profile,
          run,
          ...bootTiming(timing.responseStart, timing.observation),
          responseEndMs: timing.responseEnd,
          domReadyMs: timing.domReadyMs,
          afterDomReadyMs: timing.observation.shownMs - timing.domReadyMs,
          completedAtDisplay: bootTransfers(
            completedResources.filter((resource) => resource.finishedAtMs <= timing.observation.shownMs),
          ),
          ...bootTransfers(resources),
          resources: completedResources,
        });
      } finally {
        await context.close();
      }
    }
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    pnpm: command('pnpm', ['--version']).trim(),
    browser: browser.version(),
    head: command('git', ['rev-parse', 'HEAD']).trim(),
    changes: command('git', ['status', '--porcelain']),
    route,
    runs,
    network,
    port,
    expectedHeading,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
    theme: 'simple_light',
    compression: 'gzip',
    networks: bootNetworks,
    failureSummaries: networks.map((profile) => ({
      profile,
      ...bootFailureSummary(samples.filter((sample) => sample.profile === profile)),
    })),
    samples,
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    '| 回線 | HTML応答開始 p50 ms | DOM準備 p50 ms | 表示 p50 ms | DOM準備後 p50 ms | 失敗表示 p50 ms | 失敗あり/試行数 | 表示までに完了 kB/件 | 安定後 kB/件 |',
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const profile of networks) {
    const rows = samples.filter((sample) => sample.profile === profile);
    const failures = bootFailureSummary(rows);
    const median = (key: 'htmlMs' | 'domReadyMs' | 'shownMs' | 'afterDomReadyMs' | 'failedMs' | 'bytes' | 'requests') =>
      percentile(
        rows.map((row) => row[key]),
        0.5,
      );
    console.log(
      `| ${profile} | ${median('htmlMs').toFixed(0)} | ${median('domReadyMs').toFixed(0)} | ${median('shownMs').toFixed(0)} | ${median('afterDomReadyMs').toFixed(0)} | ${median('failedMs').toFixed(0)} | ${failures.failedRuns}/${failures.runs} | ${(
        percentile(
          rows.map((row) => row.completedAtDisplay.bytes),
          0.5,
        ) / 1000
      ).toFixed(1)}/${percentile(
        rows.map((row) => row.completedAtDisplay.requests),
        0.5,
      )} | ${(median('bytes') / 1000).toFixed(1)}/${median('requests')} |`,
    );
  }
  console.log(`詳細: ${output}`);
} finally {
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await tracked?.stop();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
  rmSync(dir, { recursive: true, force: true });
  console.log(`削除済み: ${dir}`);
}
