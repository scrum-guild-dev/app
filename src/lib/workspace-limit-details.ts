// 409 の workspace_limit_reached の details（{ used, limit }）から、画面に出す数を取り出す。
// details は unknown なので、形と値を確かめ、読めないときは undefined を返す
export type WorkspaceLimitDetails = { used: number; limit: number };

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function workspaceLimitDetailsOf(details: unknown): WorkspaceLimitDetails | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const record = details as Record<string, unknown>;
  const used = countOf(record.used);
  const limit = countOf(record.limit);
  if (used === undefined || limit === undefined) return undefined;
  return { used, limit };
}
