// e2e の間、手元の wrangler dev が応答しなくなる時間を見つけてログに出す（#1146）。
// CI の e2e で、ふだん数十ミリ秒で返る API がまとめて数秒返らず、5 秒の expect が切れる揺れが続いている。
// 止まる場所を切り分けるため、Worker を通らない静的ファイル、D1 を通らない Worker の応答、D1 を通る /api/health を
// それぞれ一定の間隔で問い合わせ、しきい値以上かかったものを時刻つきで残す。どこまで止まったかで、workerd ごとか、
// Worker か、D1 かが分かる。時刻は Playwright のログ（各行の先頭の時刻）と突き合わせられるよう、壁時計で取る。
// テストの画面には触れない（Playwright の親プロセスから Node の fetch で送る）
import { setTimeout as delay } from 'node:timers/promises';

export type ProbeTargetName = 'asset' | 'worker' | 'd1';
export type ProbeTarget = { name: ProbeTargetName; path: string };

export const PROBE_TARGETS: readonly ProbeTarget[] = [
  // build した静的ファイル。assets が返し、Worker（src/server）を通らない
  { name: 'asset', path: '/theme-init.js' },
  // 操作の無いパス。Worker の notFound が 404 を返し、D1 に触れない
  { name: 'worker', path: '/api/e2e-stall-probe' },
  // D1 に SELECT 1 を送る（src/server/app.ts の /health）
  { name: 'd1', path: '/api/health' },
];

export const PROBE_INTERVAL_MS = 500;
// e2e の expect の 5 秒に対して、テストを落としうる止まりの手前で拾う
export const STALL_THRESHOLD_MS = 1_000;
const PROBE_TIMEOUT_MS = 30_000;
// 止まり続けたときにログを埋めない
export const MAX_REPORTED_STALLS = 200;
const PREFIX = '[e2e-stall]';

export type ProbeResponse = { status: number; arrayBuffer: () => Promise<ArrayBuffer> };
export type ProbeDeps = {
  fetch: (url: string, signal: AbortSignal) => Promise<ProbeResponse>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type Stall = { target: ProbeTargetName; startedAt: number; ms: number; result: string };
export type ProbeReport = { counts: Record<ProbeTargetName, number>; stalls: Stall[] };
export type StallProbe = { stop: () => Promise<ProbeReport> };

export const nodeProbeDeps: ProbeDeps = {
  fetch: (url, signal) => fetch(url, { signal }),
  now: () => Date.now(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal }).catch(() => {});
  },
};

// 1 回問い合わせ、かかった時間と結果（HTTP ステータスか例外の名前）を返す。本文は読み切って接続を返す
export async function probeOnce(
  url: string,
  deps: ProbeDeps,
  signal: AbortSignal,
): Promise<{ startedAt: number; ms: number; result: string }> {
  const startedAt = deps.now();
  let result: string;
  try {
    const response = await deps.fetch(url, AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]));
    await response.arrayBuffer();
    result = String(response.status);
  } catch (error) {
    result = signal.aborted ? '止めるまで応答なし' : error instanceof Error ? error.name : 'error';
  }
  return { startedAt, ms: deps.now() - startedAt, result };
}

export type ProbeOptions = { intervalMs: number; thresholdMs: number };
const DEFAULT_OPTIONS: ProbeOptions = { intervalMs: PROBE_INTERVAL_MS, thresholdMs: STALL_THRESHOLD_MS };

// 3 か所をそれぞれ順に問い合わせ続ける。1 か所の問い合わせは前の応答を待ってから送るので、止まりは 1 件の長い問い合わせとして残る
export function startStallProbe(
  baseURL: string,
  deps: ProbeDeps = nodeProbeDeps,
  { intervalMs, thresholdMs }: ProbeOptions = DEFAULT_OPTIONS,
): StallProbe {
  const controller = new AbortController();
  const counts: Record<ProbeTargetName, number> = { asset: 0, worker: 0, d1: 0 };
  const stalls: Stall[] = [];
  const loops = PROBE_TARGETS.map(async (target) => {
    const url = new URL(target.path, baseURL).toString();
    while (!controller.signal.aborted) {
      const { startedAt, ms, result } = await probeOnce(url, deps, controller.signal);
      counts[target.name] += 1;
      if (ms >= thresholdMs) stalls.push({ target: target.name, startedAt, ms, result });
      await deps.sleep(intervalMs, controller.signal);
    }
  });
  return {
    stop: async () => {
      controller.abort();
      await Promise.all(loops);
      return { counts, stalls: stalls.toSorted((a, b) => a.startedAt - b.startedAt) };
    },
  };
}

export function formatStallReport({ counts, stalls }: ProbeReport): string[] {
  const asked = PROBE_TARGETS.map(({ name }) => `${name} ${counts[name]} 回`).join('、');
  const head = `${PREFIX} ${asked}を問い合わせた（${STALL_THRESHOLD_MS}ms 以上かかったものを出す）`;
  if (stalls.length === 0) return [`${head}。該当なし`];
  const lines = stalls
    .slice(0, MAX_REPORTED_STALLS)
    .map(
      ({ target, startedAt, ms, result }) =>
        `${PREFIX} ${new Date(startedAt).toISOString()} ${target} ${Math.round(ms)}ms ${result}`,
    );
  const rest = stalls.length - lines.length;
  return [`${head}。${stalls.length} 件`, ...lines, ...(rest > 0 ? [`${PREFIX} ほか ${rest} 件`] : [])];
}
