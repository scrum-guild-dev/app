import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, trialTiming, comparison } from './loading-stats.ts';
test('nearest-rank: 並べ替え、偶数、p95、単一、元を変えない', () => {
  const values = [4, 1, 3, 2];
  assert.equal(percentile(values, 0.5), 2);
  assert.equal(percentile(values, 0.95), 4);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(
    percentile(
      Array.from({ length: 20 }, (_, i) => i + 1),
      0.95,
    ),
    19,
  );
  assert.deepEqual(values, [4, 1, 3, 2]);
});
test('空、不正な時間と分位点を拒否', () => {
  for (const values of [[], [-1], [NaN], [Infinity]]) assert.throws(() => percentile(values, 0.5));
  for (const p of [0, -1, 1.1, NaN]) assert.throws(() => percentile([1], p));
  assert.throws(() => trialTiming([{ ms: 1, secondary: true }]));
});
test('各試行の主の最大、従の最大と正の差を使う', () => {
  assert.deepEqual(
    trialTiming([
      { ms: 20, secondary: false },
      { ms: 30, secondary: false },
      { ms: 50, secondary: true },
    ]),
    { primary: 30, secondary: 50, total: 50, saving: 20 },
  );
  assert.equal(
    trialTiming([
      { ms: 30, secondary: false },
      { ms: 20, secondary: true },
    ]).saving,
    0,
  );
  assert.equal(trialTiming([{ ms: 30, secondary: false }]).saving, 0);
  assert.equal(
    trialTiming([
      { ms: 30, secondary: false },
      { ms: 30, secondary: true },
    ]).saving,
    0,
  );
});
test('分位点の差ではなく、対応する試行ごとの短縮で判定する', () => {
  const trials = [
    trialTiming([
      { ms: 100, secondary: false },
      { ms: 101, secondary: true },
    ]),
    trialTiming([
      { ms: 1, secondary: false },
      { ms: 10, secondary: true },
    ]),
    trialTiming([
      { ms: 2, secondary: false },
      { ms: 20, secondary: true },
    ]),
  ];
  assert.deepEqual(comparison(trials), { p50Saving: 9, p95Saving: 18 });
  assert.deepEqual(comparison([trialTiming([{ ms: 10, secondary: false }])]), { p50Saving: 0, p95Saving: 0 });
});

test('発行順で変わる完了差を診断値として別々に報告する', () => {
  const mainFirst = [
    trialTiming([
      { ms: 10, secondary: false },
      { ms: 20, secondary: true },
    ]),
  ];
  const secondaryFirst = [
    trialTiming([
      { ms: 20, secondary: false },
      { ms: 10, secondary: true },
    ]),
  ];
  assert.equal(comparison(mainFirst).p50Saving, 10);
  assert.equal(comparison(secondaryFirst).p50Saving, 0);
});
