import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_PROBE_OPTIONS,
  formatStall,
  formatStallSummary,
  isNotable,
  nodeProbeDeps,
  PROBE_INTERVAL_MS,
  PROBE_TARGETS,
  PROBE_TIMEOUT_MS,
  probeOnce,
  type ProbeDeps,
  type Stall,
  stallLogger,
  startStallProbe,
  STALL_THRESHOLD_MS,
} from './e2e-stall-probe.ts';

const BASE = 'http://localhost:8787';
const ok = (status = 200) => ({ status, arrayBuffer: async () => new ArrayBuffer(0) });
const EXPECTED: Record<string, number> = Object.fromEntries(PROBE_TARGETS.map((t) => [t.path, t.expectedStatus]));
const target = (name: string) => PROBE_TARGETS.find((t) => t.name === name)!;

// 条件が満たされるまで待つ。満たされなければ落とす（ループが止まらずテストが終わらなくなるのを防ぐ）
async function waitUntil(condition: () => boolean, limitMs = 5_000): Promise<void> {
  const deadline = performance.now() + limitMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('待ちの上限を超えた');
    await delay(5);
  }
}

describe('既定の値', () => {
  test('0.5 秒おきに問い合わせ、1 秒以上を止まりとし、30 秒で切る', () => {
    assert.equal(PROBE_INTERVAL_MS, 500);
    assert.equal(STALL_THRESHOLD_MS, 1_000);
    assert.equal(PROBE_TIMEOUT_MS, 30_000);
    assert.deepEqual(
      { ...DEFAULT_PROBE_OPTIONS, onStall: undefined },
      { intervalMs: 500, thresholdMs: 1_000, timeoutMs: 30_000, onStall: undefined },
    );
  });
});

describe('probeOnce', () => {
  test('所要時間は単調な時計の差で測り、壁時計が飛んでも変わらない', async () => {
    let wall = Date.UTC(2026, 10, 10, 14, 0, 0);
    let mono = 0;
    const deps: ProbeDeps = {
      ...nodeProbeDeps,
      now: () => wall,
      elapsed: () => mono,
      fetch: async () => {
        wall += 5_000; // 時計の補正で壁時計だけが進む
        mono += 20;
        return ok();
      },
    };
    const result = await probeOnce(`${BASE}/api/health`, deps, new AbortController().signal);
    assert.deepEqual(result, { startedAt: Date.UTC(2026, 10, 10, 14, 0, 0), ms: 20, result: '200' });
  });

  test('通信の失敗は例外の名前を返し、止めた後の失敗は止めるまで応答なしとする', async () => {
    const failing: ProbeDeps = { ...nodeProbeDeps, fetch: async () => Promise.reject(new TypeError('fetch failed')) };
    assert.equal((await probeOnce(`${BASE}/api/health`, failing, new AbortController().signal)).result, 'TypeError');
    const stopped = new AbortController();
    stopped.abort();
    assert.equal((await probeOnce(`${BASE}/api/health`, failing, stopped.signal)).result, '止めるまで応答なし');
  });

  test('応答が無ければ timeoutMs で切り、TimeoutError とする', async () => {
    const hanging: ProbeDeps = {
      ...nodeProbeDeps,
      fetch: (_url, signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    };
    const result = await probeOnce(`${BASE}/api/health`, hanging, new AbortController().signal, 50);
    assert.equal(result.result, 'TimeoutError');
    assert.ok(result.ms >= 40, `${result.ms}`);
  });
});

describe('isNotable', () => {
  test('しきい値ちょうどは残し、1ms 短ければ残さない', () => {
    assert.equal(isNotable(target('d1'), 1_000, '200', 1_000), true);
    assert.equal(isNotable(target('d1'), 999, '200', 1_000), false);
  });

  test('速くても、想定と違う応答と接続の失敗は残す', () => {
    assert.equal(isNotable(target('worker'), 5, '404', 1_000), false);
    assert.equal(isNotable(target('worker'), 5, '200', 1_000), true);
    assert.equal(isNotable(target('d1'), 5, '503', 1_000), true);
    assert.equal(isNotable(target('asset'), 3, 'TypeError', 1_000), true);
  });
});

describe('startStallProbe', () => {
  // 3 か所の問い合わせは並んで進み、偽の時計を共有すると互いの所要時間が混ざるので、実時間で、しきい値と止まりを大きく離して確かめる
  test('3 か所を問い合わせ続け、止まりを見つけた時点で知らせ、始めた時刻の順に返す', async () => {
    const calls: string[] = [];
    const seen: Stall[] = [];
    const deps: ProbeDeps = {
      ...nodeProbeDeps,
      fetch: async (url) => {
        const { pathname } = new URL(url);
        calls.push(pathname);
        const call = calls.filter((p) => p === pathname).length;
        // d1 の 2 回目が先に始まり長く止まり、worker の 3 回目が後に始まって先に終わる
        if (pathname === '/api/health' && call === 2) await delay(1_200);
        if (pathname === '/api/e2e-stall-probe' && call === 3) await delay(800);
        return ok(EXPECTED[pathname]);
      },
    };
    const probe = startStallProbe(BASE, deps, { intervalMs: 5, thresholdMs: 500, onStall: (s) => seen.push(s) });
    await waitUntil(() => calls.filter((p) => p === '/api/health').length >= 3);
    const report = await probe.stop();

    assert.deepEqual(new Set(calls), new Set(PROBE_TARGETS.map((t) => t.path)));
    for (const count of Object.values(report.counts)) assert.ok(count >= 2);
    assert.deepEqual(
      report.stalls.map(({ target, result }) => ({ target, result })),
      [
        { target: 'd1', result: '200' },
        { target: 'worker', result: '404' },
      ],
    );
    assert.ok(report.stalls[0]!.startedAt <= report.stalls[1]!.startedAt);
    // 見つけた順（終わった順）に知らせる
    assert.deepEqual(
      seen.map((s) => s.target),
      ['worker', 'd1'],
    );
  });

  test('サーバーが落ちて接続を拒まれると、速く返っても残す', async () => {
    const deps: ProbeDeps = { ...nodeProbeDeps, fetch: async () => Promise.reject(new TypeError('fetch failed')) };
    const probe = startStallProbe(BASE, deps, { intervalMs: 5 });
    await delay(30);
    const report = await probe.stop();
    assert.ok(report.stalls.length >= 3);
    assert.deepEqual(new Set(report.stalls.map((s) => s.result)), new Set(['TypeError']));
  });

  test('止めると、待ちの途中でも応答を待っている途中でもすぐ終わり、待っていた問い合わせは止めるまで応答なしで残す', async () => {
    const deps: ProbeDeps = {
      ...nodeProbeDeps,
      // d1 だけ返らない。止めると fetch が中断される
      fetch: (url, signal) =>
        new URL(url).pathname === '/api/health'
          ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
          : Promise.resolve(ok(EXPECTED[new URL(url).pathname])),
    };
    // 間隔を長くし、asset と worker は待ちの途中で止める
    const probe = startStallProbe(BASE, deps, { intervalMs: 60_000, thresholdMs: 100 });
    await delay(200);
    const from = performance.now();
    const report = await probe.stop();
    assert.ok(performance.now() - from < 1_000);
    assert.deepEqual(
      report.stalls.map(({ target, result }) => ({ target, result })),
      [{ target: 'd1', result: '止めるまで応答なし' }],
    );
  });

  test('測る側の待ちが予定より延びたら、probe の遅れとして残す', async () => {
    let mono = 0;
    const deps: ProbeDeps = {
      ...nodeProbeDeps,
      elapsed: () => mono,
      fetch: async (url) => ok(EXPECTED[new URL(url).pathname]),
      // 待ちのたびに、予定の 5ms に 2 秒の遅れを足す
      sleep: async (ms, signal) => {
        mono += ms + 2_000;
        await delay(1, undefined, { signal }).catch(() => {});
      },
    };
    const probe = startStallProbe(BASE, deps, { intervalMs: 5, thresholdMs: 1_000 });
    await delay(30);
    const report = await probe.stop();
    const lags = report.stalls.filter((s) => s.target === 'probe');
    assert.ok(lags.length >= 1);
    assert.ok(lags.every((s) => s.result === '遅れ'));
  });
});

describe('ログの行', () => {
  const stall: Stall = { target: 'd1', startedAt: Date.UTC(2026, 10, 10, 14, 46, 58, 190), ms: 3821.6, result: '200' };

  test('始めた時刻（UTC）、場所、かかった時間、結果を 1 行で出す', () => {
    assert.equal(formatStall(stall), '[e2e-stall] 2026-11-10T14:46:58.190Z d1 3822ms 200');
  });

  test('上限までは 1 件 1 行で出し、超えたら 1 回だけ知らせて以降は出さない', () => {
    const lines: string[] = [];
    const log = stallLogger((line) => lines.push(line), 2);
    for (let i = 0; i < 5; i += 1) log(stall);
    assert.deepEqual(lines, [
      formatStall(stall),
      formatStall(stall),
      '[e2e-stall] 2 件を超えたので、以降の行は出さない',
    ]);
  });

  test('終わりの集計に、問い合わせた回数と件数を出す', () => {
    assert.equal(
      formatStallSummary({ counts: { asset: 10, worker: 10, d1: 9 }, stalls: [stall] }),
      '[e2e-stall] asset 10 回、worker 10 回、d1 9 回を問い合わせ、1000ms 以上の遅れか想定と違う応答は 1 件',
    );
  });
});
