import type { BacklogTask } from '../shared/operations/task/backlog-tree.ts';
import { completionSettled } from './added-rows.ts';

// 同じ時刻の読み込みも区別する。起票より後に要求した木だけが、その起票を必ず含む。
let readVersion = 0;
export function startBacklogRead(): number {
  return ++readVersion;
}
export function backlogReadVersion(): number {
  return readVersion;
}
export type PendingBacklogTask = { task: BacklogTask; afterRead: number };
export function pendingBacklogTasks(
  added: readonly PendingBacklogTask[],
  loadedRead: number,
  treeLoaded: boolean,
): PendingBacklogTask[] {
  return added.filter((entry) => !treeLoaded || loadedRead <= entry.afterRead);
}

export type SavedBacklogPoints = Record<string, { value: BacklogTask['points']; at: number }>;

// 応答より後に読み始めた木だけが保存を含む。同時刻や失敗した読み込みでは補正を残す。
export function pendingBacklogPoints(
  changes: SavedBacklogPoints,
  loadedAt: number,
  treeLoaded: boolean,
): SavedBacklogPoints {
  return Object.fromEntries(
    Object.entries(changes).filter(([, change]) => !treeLoaded || !completionSettled(change.at, loadedAt)),
  );
}

export type BacklogCounts = {
  open_count: number;
  unfilled_count: number;
  unestimated_count: number;
  unscheduled_count: number;
};

// サーバーの全体の値に、読み直すまでの変更だけを足す。表示された木を全件と見なさない。
export function backlogTallies(
  counts: BacklogCounts,
  loaded: readonly BacklogTask[],
  added: readonly BacklogTask[],
  completed: readonly string[],
  points: Readonly<Record<string, { value: BacklogTask['points'] }>>,
): BacklogCounts {
  const result = { ...counts };
  const loadedIds = new Set(loaded.map((row) => row.id));
  const done = new Set(completed);
  const seen = new Set<string>();
  for (const row of [...loaded, ...added]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const before = loadedIds.has(row.id) ? 1 : 0;
    const after = done.has(row.id) ? 0 : 1;
    const change = points[row.id];
    const estimated = change === undefined ? row.points : change.value;
    result.open_count += after - before;
    result.unfilled_count += Number(row.unfilled) * (after - before);
    result.unestimated_count += Number(estimated === null) * after - Number(row.points === null) * before;
    result.unscheduled_count += Number(row.sprint === null) * (after - before);
  }
  return result;
}
