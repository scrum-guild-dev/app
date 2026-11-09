// 分位点は nearest-rank（0 < p <= 1）。空、非有限値、負の時間は計測失敗として拒否する。
export function percentile(values: readonly number[], p: number): number {
  if (!values.length || !Number.isFinite(p) || p <= 0 || p > 1 || values.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error('分位点の入力が不正です');
  }
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
}
export type Timing = { ms: number; secondary: boolean };
export function trialTiming(operations: readonly Timing[]) {
  const primary = operations.filter((o) => !o.secondary).map((o) => o.ms);
  if (!primary.length) throw new Error('主の操作が必要です');
  // 入力は percentile と同じ規則で確かめる。
  percentile(
    operations.map((o) => o.ms),
    1,
  );
  const main = Math.max(...primary);
  const secondary = Math.max(0, ...operations.filter((o) => o.secondary).map((o) => o.ms));
  return { primary: main, secondary, total: Math.max(main, secondary), saving: Math.max(0, secondary - main) };
}
// 完了差の分位点は診断値。ローカルの直列処理から実装の可否を判定しない。
export function comparison(trials: readonly ReturnType<typeof trialTiming>[]) {
  return {
    p50Saving: percentile(
      trials.map((t) => t.saving),
      0.5,
    ),
    p95Saving: percentile(
      trials.map((t) => t.saving),
      0.95,
    ),
  };
}
