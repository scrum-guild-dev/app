// DevTools のプリセット。帯域は bits/s から bytes/s にし、DevTools と同じ補正を掛ける。
export const bootNetworks = {
  fast: { latency: 150 * 3.75, downloadThroughput: (1.6 * 1_000_000 * 0.9) / 8, uploadThroughput: (750_000 * 0.9) / 8 },
  slow: { latency: 400 * 5, downloadThroughput: (400_000 * 0.8) / 8, uploadThroughput: (400_000 * 0.8) / 8 },
} as const;

export type BootObservation = { seen: boolean; shownMs: number; failedAtMs: number | null };
export function assertBootHeading(headings: readonly string[], expected: string) {
  if (!expected.trim() || !headings.some((heading) => heading.trim() === expected.trim())) {
    throw new Error('目的の画面を表示できませんでした（見出しが一致しません）');
  }
}
export function bootTiming(responseStart: number, observation: BootObservation) {
  if (
    !observation.seen ||
    !Number.isFinite(responseStart) ||
    responseStart <= 0 ||
    !Number.isFinite(observation.shownMs) ||
    observation.shownMs < responseStart ||
    (observation.failedAtMs !== null &&
      (!Number.isFinite(observation.failedAtMs) ||
        observation.failedAtMs < responseStart ||
        observation.failedAtMs > observation.shownMs))
  ) {
    throw new Error('初回表示の観測が不正です');
  }
  return {
    htmlMs: responseStart,
    shownMs: observation.shownMs,
    afterHtmlMs: observation.shownMs - responseStart,
    failedMs: observation.failedAtMs === null ? 0 : observation.shownMs - observation.failedAtMs,
  };
}

export type BootResource = { url: string; type: string; bytes: number; gzip: boolean };
export function bootTransfers(resources: readonly BootResource[]) {
  const groups: Record<string, { requests: number; bytes: number }> = {};
  for (const resource of resources) {
    if (!Number.isFinite(resource.bytes) || resource.bytes < 0) throw new Error('転送量の観測が不正です');
    const group = (groups[resource.type] ??= { requests: 0, bytes: 0 });
    group.requests++;
    group.bytes += resource.bytes;
  }
  return { requests: resources.length, bytes: resources.reduce((sum, resource) => sum + resource.bytes, 0), groups };
}
