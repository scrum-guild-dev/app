import { expect, test } from 'vitest';
import type { BacklogTask } from '../shared/operations/task/backlog-tree.ts';
import { backlogTallies, pendingBacklogPoints } from './backlog-tallies.ts';

const row = (id: string, changes: Partial<BacklogTask> = {}): BacklogTask => ({
  id,
  title: id,
  points: null,
  due_on: null,
  assignee: null,
  category: null,
  repository: null,
  sprint: null,
  unfilled: true,
  can_delete: true,
  ...changes,
});
const counts = { open_count: 100, unfilled_count: 50, unestimated_count: 20, unscheduled_count: 30 };

test('同時刻の古い木と失敗した読み込みでは保存した見積もりを残し、後に読んだ木で捨てる', () => {
  const changes = { task: { value: 5 as const, at: 100 } };
  expect(pendingBacklogPoints(changes, 99, true)).toEqual(changes);
  expect(pendingBacklogPoints(changes, 100, true)).toEqual(changes);
  expect(pendingBacklogPoints(changes, 101, true)).toEqual({});
  expect(pendingBacklogPoints(changes, 101, false)).toEqual(changes);
});

test('表示の木が一部でもサーバーの全体の値を保ち、起票と完了だけを差し引く', () => {
  const loaded = row('loaded');
  const fresh = row('fresh');
  expect(backlogTallies(counts, [loaded], [fresh], [], {})).toEqual({
    open_count: 101,
    unfilled_count: 51,
    unestimated_count: 21,
    unscheduled_count: 31,
  });
  expect(backlogTallies(counts, [loaded], [fresh], ['loaded'], {})).toEqual(counts);
  expect(backlogTallies(counts, [loaded], [fresh], ['loaded', 'fresh'], {})).toEqual({
    open_count: 99,
    unfilled_count: 49,
    unestimated_count: 19,
    unscheduled_count: 29,
  });
});

test('起票した行が読み直しにもあれば重ねず、見積もりの付け外しと完了を二重に引かない', () => {
  const task = row('task');
  expect(backlogTallies(counts, [task], [task], [], { task: { value: 0 } })).toEqual({
    ...counts,
    unestimated_count: 19,
  });
  expect(backlogTallies(counts, [task], [task], ['task'], { task: { value: 5 } })).toEqual({
    open_count: 99,
    unfilled_count: 49,
    unestimated_count: 19,
    unscheduled_count: 29,
  });
  expect(
    backlogTallies(counts, [row('task', { points: 3, unfilled: false })], [], [], { task: { value: null } }),
  ).toEqual({
    ...counts,
    unestimated_count: 21,
  });
});

test('スプリント入りの見積もり済みの行の完了は、未見積もりと未割り当てを減らさない', () => {
  const task = row('task', {
    points: 3,
    unfilled: false,
    sprint: { id: 'sprint', name: '試す', start_on: '2026-11-01', end_on: '2026-11-14' },
  });
  expect(backlogTallies(counts, [task], [], ['task'], {})).toEqual({ ...counts, open_count: 99 });
});
