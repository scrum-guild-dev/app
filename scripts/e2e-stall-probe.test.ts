import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  formatStallReport,
  MAX_REPORTED_STALLS,
  nodeProbeDeps,
  probeOnce,
  type ProbeDeps,
  type ProbeReport,
  type Stall,
  startStallProbe,
} from './e2e-stall-probe.ts';

const BASE = 'http://localhost:8787';
const ok = (status = 200) => ({ status, arrayBuffer: async () => new ArrayBuffer(0) });

// 1 回の問い合わせごとに、時計を cost だけ進める偽物
function fakeDeps(cost: number): ProbeDeps {
  let clock = Date.UTC(2026, 10, 10, 14, 0, 0);
  return {
    now: () => clock,
    fetch: async () => {
      clock += cost;
      return ok();
    },
    sleep: async () => {},
  };
}

describe('probeOnce', () => {
  test('かかった時間と HTTP ステータスを返す', async () => {
    const deps = fakeDeps(1500);
    const result = await probeOnce(`${BASE}/api/health`, deps, new AbortController().signal);
    assert.equal(result.ms, 1500);
    assert.equal(result.result, '200');
  });

  test('通信の失敗は例外の名前を返し、止めた後の失敗は止めるまで応答なしとする', async () => {
    const failing: ProbeDeps = {
      ...fakeDeps(0),
      fetch: async () => Promise.reject(new TypeError('fetch failed')),
    };
    assert.equal((await probeOnce(`${BASE}/api/health`, failing, new AbortController().signal)).result, 'TypeError');
    const stopped = new AbortController();
    stopped.abort();
    assert.equal((await probeOnce(`${BASE}/api/health`, failing, stopped.signal)).result, '止めるまで応答なし');
  });
});

describe('startStallProbe', () => {
  // 3 か所の問い合わせは並んで進み、偽の時計を共有すると互いの所要時間が混ざるので、実時間の短い値で確かめる
  test('3 か所を問い合わせ続け、しきい値以上かかったものだけを止まりとして残す', async () => {
    const calls: string[] = [];
    const deps: ProbeDeps = {
      ...nodeProbeDeps,
      fetch: async (url) => {
        const { pathname } = new URL(url);
        calls.push(pathname);
        // d1 の 2 回目だけ止まる。ほかは待たずに返す
        if (pathname === '/api/health' && calls.filter((p) => p === pathname).length === 2) await delay(300);
        return ok(pathname === '/api/e2e-stall-probe' ? 404 : 200);
      },
    };
    const probe = startStallProbe(BASE, deps, { intervalMs: 5, thresholdMs: 100 });
    while (calls.filter((p) => p === '/api/health').length < 3) await delay(5);
    const report = await probe.stop();

    assert.deepEqual(new Set(calls), new Set(['/theme-init.js', '/api/e2e-stall-probe', '/api/health']));
    for (const count of Object.values(report.counts)) assert.ok(count >= 2);
    assert.equal(report.stalls.length, 1);
    const [stall] = report.stalls as [Stall];
    assert.equal(stall.target, 'd1');
    assert.equal(stall.result, '200');
    assert.ok(stall.ms >= 290 && stall.ms < 1000, `${stall.ms}`);
    // 止めた後は問い合わせない
    const after = calls.length;
    await delay(30);
    assert.equal(calls.length, after);
  });

  test('止めたときに応答を待っている問い合わせは、待った時間で止まりとして残す', async () => {
    const deps: ProbeDeps = {
      ...nodeProbeDeps,
      // d1 だけ返らない。止めると fetch が中断される
      fetch: (url, signal) =>
        new URL(url).pathname === '/api/health'
          ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
          : Promise.resolve(ok()),
    };
    const probe = startStallProbe(BASE, deps, { intervalMs: 5, thresholdMs: 100 });
    await delay(200);
    const report = await probe.stop();
    assert.deepEqual(
      report.stalls.map(({ target, result }) => ({ target, result })),
      [{ target: 'd1', result: '止めるまで応答なし' }],
    );
  });
});

describe('formatStallReport', () => {
  const counts = { asset: 10, worker: 10, d1: 9 };

  test('止まりが無ければ、問い合わせた回数と該当なしの 1 行', () => {
    assert.deepEqual(formatStallReport({ counts, stalls: [] }), [
      '[e2e-stall] asset 10 回、worker 10 回、d1 9 回を問い合わせた（1000ms 以上かかったものを出す）。該当なし',
    ]);
  });

  test('止まりは件数の後に、始めた時刻（UTC）、場所、かかった時間、結果を 1 件 1 行で出す', () => {
    const stalls: Stall[] = [
      { target: 'd1', startedAt: Date.UTC(2026, 10, 10, 14, 46, 58, 190), ms: 3821.6, result: '200' },
      { target: 'asset', startedAt: Date.UTC(2026, 10, 10, 14, 46, 58, 200), ms: 5300, result: '止めるまで応答なし' },
    ];
    assert.deepEqual(formatStallReport({ counts, stalls }), [
      '[e2e-stall] asset 10 回、worker 10 回、d1 9 回を問い合わせた（1000ms 以上かかったものを出す）。2 件',
      '[e2e-stall] 2026-11-10T14:46:58.190Z d1 3822ms 200',
      '[e2e-stall] 2026-11-10T14:46:58.200Z asset 5300ms 止めるまで応答なし',
    ]);
  });

  test('上限を超えた分は、行を出さず件数だけ出す', () => {
    const stall: Stall = { target: 'd1', startedAt: 0, ms: 2000, result: '200' };
    const report: ProbeReport = { counts, stalls: Array.from({ length: MAX_REPORTED_STALLS + 3 }, () => stall) };
    const lines = formatStallReport(report);
    assert.equal(lines.length, 1 + MAX_REPORTED_STALLS + 1);
    assert.equal(lines.at(-1), '[e2e-stall] ほか 3 件');
  });
});
