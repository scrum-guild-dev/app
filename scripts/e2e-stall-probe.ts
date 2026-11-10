// e2e の間、手元の wrangler dev が応答しなくなる時間を見つけてログに出す（#1146）。
// CI の e2e で、ふだん数十ミリ秒で返る API がまとめて数秒返らず、5 秒の expect が切れる揺れが続いている。
// 止まる場所を切り分けるため、Worker を通らない静的ファイル、D1 を通らない Worker の応答、D1 を通る /api/health を
// それぞれ一定の間隔で問い合わせ、しきい値以上かかったものと、想定と違う応答（接続の失敗を含む）を残す。
// 測る側（Playwright の親プロセス）の遅れも `probe` として残し、3 か所が同時に遅れたときに、サーバーの止まりと見分ける。
// 所要時間は単調な時計で測り、始めた時刻だけを Playwright のログ（各行の先頭の時刻）と突き合わせるため壁時計で取る。
// テストの画面には触れない（親プロセスから Node の fetch で送る）
import { setTimeout as delay } from 'node:timers/promises';

export type ProbeTargetName = 'asset' | 'worker' | 'd1';
export type ProbeTarget = { name: ProbeTargetName; path: string; expectedStatus: number };

export const PROBE_TARGETS: readonly ProbeTarget[] = [
  // build した静的ファイル。assets が返し、Worker（src/server）を通らない
  { name: 'asset', path: '/theme-init.js', expectedStatus: 200 },
  // 操作の無いパス。Worker の notFound が 404 を返し、D1 に触れない
  { name: 'worker', path: '/api/e2e-stall-probe', expectedStatus: 404 },
  // D1 に SELECT 1 を送る（src/server/app.ts の /health）
  { name: 'd1', path: '/api/health', expectedStatus: 200 },
];

export const PROBE_INTERVAL_MS = 500;
// e2e の expect の 5 秒に対して、テストを落としうる止まりの手前で拾う
export const STALL_THRESHOLD_MS = 1_000;
export const PROBE_TIMEOUT_MS = 30_000;
// 止まり続けたときにログを埋めない
export const MAX_REPORTED_STALLS = 200;
const PREFIX = '[e2e-stall]';

export type ProbeResponse = { status: number; arrayBuffer: () => Promise<ArrayBuffer> };
export type ProbeDeps = {
  fetch: (url: string, signal: AbortSignal) => Promise<ProbeResponse>;
  // ログと突き合わせる時刻（壁時計）
  now: () => number;
  // 所要時間を測る単調な時計
  elapsed: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

// probe は測る側（親プロセス）の遅れ。問い合わせの間の待ちが、予定よりどれだけ延びたか
export type StallSource = ProbeTargetName | 'probe';
export type Stall = { target: StallSource; startedAt: number; ms: number; result: string };
export type ProbeReport = { counts: Record<ProbeTargetName, number>; stalls: Stall[] };
export type StallProbe = { stop: () => Promise<ProbeReport> };
export type ProbeOptions = {
  intervalMs: number;
  thresholdMs: number;
  timeoutMs: number;
  // 残すと決めた時点で呼ぶ。ジョブが途中で切られても、それまでの分がログに残る
  onStall: (stall: Stall) => void;
};

export const DEFAULT_PROBE_OPTIONS: ProbeOptions = {
  intervalMs: PROBE_INTERVAL_MS,
  thresholdMs: STALL_THRESHOLD_MS,
  timeoutMs: PROBE_TIMEOUT_MS,
  onStall: () => {},
};

export const nodeProbeDeps: ProbeDeps = {
  fetch: (url, signal) => fetch(url, { signal }),
  now: () => Date.now(),
  elapsed: () => performance.now(),
  sleep: async (ms, signal) => {
    // 止めたときの中断（AbortError）は正常な終わり方
    await delay(ms, undefined, { signal }).catch(() => {});
  },
};

const STOPPED = '止めるまで応答なし';

// 1 回問い合わせ、かかった時間と結果（HTTP ステータスか例外の名前）を返す。本文は読み切って接続を返す
export async function probeOnce(
  url: string,
  deps: ProbeDeps,
  signal: AbortSignal,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ startedAt: number; ms: number; result: string }> {
  const startedAt = deps.now();
  const from = deps.elapsed();
  let result: string;
  try {
    const response = await deps.fetch(url, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    await response.arrayBuffer();
    result = String(response.status);
  } catch (error) {
    result = signal.aborted ? STOPPED : error instanceof Error ? error.name : 'error';
  }
  return { startedAt, ms: deps.elapsed() - from, result };
}

// 残すか。しきい値以上かかったものと、想定と違う応答（接続の失敗、落ちたサーバーの即時の失敗を含む）
export function isNotable(target: ProbeTarget, ms: number, result: string, thresholdMs: number): boolean {
  return ms >= thresholdMs || result !== String(target.expectedStatus);
}

// 3 か所をそれぞれ順に問い合わせ続ける。1 か所の問い合わせは前の応答を待ってから送るので、止まりは 1 件の長い問い合わせとして残る
export function startStallProbe(
  baseURL: string,
  deps: ProbeDeps = nodeProbeDeps,
  options: Partial<ProbeOptions> = {},
): StallProbe {
  const { intervalMs, thresholdMs, timeoutMs, onStall } = { ...DEFAULT_PROBE_OPTIONS, ...options };
  const controller = new AbortController();
  const counts: Record<ProbeTargetName, number> = { asset: 0, worker: 0, d1: 0 };
  const stalls: Stall[] = [];
  const record = (stall: Stall) => {
    stalls.push(stall);
    onStall(stall);
  };
  const loops = PROBE_TARGETS.map(async (target) => {
    const url = new URL(target.path, baseURL).toString();
    while (!controller.signal.aborted) {
      const { startedAt, ms, result } = await probeOnce(url, deps, controller.signal, timeoutMs);
      counts[target.name] += 1;
      if (isNotable(target, ms, result, thresholdMs)) record({ target: target.name, startedAt, ms, result });
      await deps.sleep(intervalMs, controller.signal);
    }
  });
  // 測る側の遅れ。待ちが予定よりしきい値以上延びたら、親プロセスのイベントループかランナー全体が詰まっている
  const lag = (async () => {
    while (!controller.signal.aborted) {
      const startedAt = deps.now();
      const from = deps.elapsed();
      await deps.sleep(intervalMs, controller.signal);
      const late = deps.elapsed() - from - intervalMs;
      if (!controller.signal.aborted && late >= thresholdMs)
        record({ target: 'probe', startedAt, ms: late, result: '遅れ' });
    }
  })();
  return {
    stop: async () => {
      controller.abort();
      await Promise.all([...loops, lag]);
      return { counts, stalls: stalls.toSorted((a, b) => a.startedAt - b.startedAt) };
    },
  };
}

export function formatStall({ target, startedAt, ms, result }: Stall): string {
  return `${PREFIX} ${new Date(startedAt).toISOString()} ${target} ${Math.round(ms)}ms ${result}`;
}

// 見つけた時点で 1 行ずつ出す。上限を超えたら、それ以降は出さない（数は終わりの集計に出る）
export function stallLogger(log: (line: string) => void, limit: number = MAX_REPORTED_STALLS): (stall: Stall) => void {
  let written = 0;
  return (stall) => {
    written += 1;
    if (written <= limit) log(formatStall(stall));
    else if (written === limit + 1) log(`${PREFIX} ${limit} 件を超えたので、以降の行は出さない`);
  };
}

// 終わりの集計。行は見つけた時点で出しているので、ここでは数だけを出す
export function formatStallSummary({ counts, stalls }: ProbeReport): string {
  const asked = PROBE_TARGETS.map(({ name }) => `${name} ${counts[name]} 回`).join('、');
  return `${PREFIX} ${asked}を問い合わせ、${STALL_THRESHOLD_MS}ms 以上の遅れか想定と違う応答は ${stalls.length} 件`;
}
