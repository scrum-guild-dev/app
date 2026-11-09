import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBootHeading, bootNetworks, bootTiming, bootTransfers } from './boot-metrics.ts';

test('HTTP200のSPAエラー画面を正常な目的画面として測らない', () => {
  for (const headings of [[], ['404'], ['500'], ['見つかりません'], ['読み込めませんでした']]) {
    assert.throws(() => assertBootHeading(headings, '今日やること'));
  }
  assertBootHeading([' 今日やること '], '今日やること');
  assert.throws(() => assertBootHeading(['404'], ''));
});

test('HTMLの応答開始と実際の失敗表示から時間を求め、15秒から推算しない', () => {
  assert.deepEqual(bootTiming(4500, { seen: true, shownMs: 12200, failedAtMs: null }), {
    htmlMs: 4500,
    shownMs: 12200,
    afterHtmlMs: 7700,
    failedMs: 0,
  });
  assert.equal(bootTiming(15900, { seen: true, shownMs: 42400, failedAtMs: 32000 }).failedMs, 10400);
  for (const observation of [
    { seen: false, shownMs: 20000, failedAtMs: null },
    { seen: true, shownMs: 100, failedAtMs: null },
    { seen: true, shownMs: 20000, failedAtMs: 21000 },
    { seen: true, shownMs: NaN, failedAtMs: null },
  ])
    assert.throws(() => bootTiming(1000, observation));
});

test('同じURLの複数転送も数え、種別と総量が一致する', () => {
  const result = bootTransfers([
    { url: '/a.js', type: 'Script', bytes: 1000, gzip: true },
    { url: '/a.js', type: 'Script', bytes: 500, gzip: true },
    { url: '/a.woff2', type: 'Font', bytes: 300, gzip: false },
  ]);
  assert.equal(result.requests, 3);
  assert.equal(result.bytes, 1800);
  assert.deepEqual(result.groups, { Script: { requests: 2, bytes: 1500 }, Font: { requests: 1, bytes: 300 } });
  assert.throws(() => bootTransfers([{ url: '/', type: 'Document', bytes: -1, gzip: true }]));
});

test('Slow 3G の補正後の帯域は40kB/s、遅延は2秒', () => {
  assert.equal(bootNetworks.slow.downloadThroughput, 40000);
  assert.equal(bootNetworks.slow.latency, 2000);
});

test('一部の試行だけ失敗表示が出た場合も、0のp50に隠さず回数と最大時間を残す', async () => {
  const { bootFailureSummary } = await import('./boot-metrics.ts');
  assert.deepEqual(bootFailureSummary([0, 12000]), { failedRuns: 1, runs: 2, maxMs: 12000 });
  assert.deepEqual(bootFailureSummary([0, 0]), { failedRuns: 0, runs: 2, maxMs: 0 });
  for (const values of [[], [-1], [NaN]]) assert.throws(() => bootFailureSummary(values));
});
