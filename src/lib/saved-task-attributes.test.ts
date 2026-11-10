import { expect, test } from 'vitest';
import type { BacklogTask } from '../shared/operations/task/backlog-tree.ts';
import { taskWithSavedAttributes } from './saved-task-attributes.ts';
const row: BacklogTask = {
  id: 't',
  title: '架空の仕事',
  points: null,
  due_on: null,
  assignee: null,
  category: null,
  repository: null,
  sprint: null,
  unfilled: false,
  can_delete: true,
};
const category = { id: 'c', name: '保守' };

test('読み直さず作った子も、親の区分を出す', () => {
  expect(taskWithSavedAttributes(row, {}, category).category).toEqual(category);
});
test('別の欄の応答で区分を戻さず、親の区分が無いときも古い自分の区分を出さない', () => {
  expect(
    taskWithSavedAttributes(
      { ...row, category },
      { repository: { task: { ...row, repository: { id: 'r', name: '架空' } }, at: 1 } },
      undefined,
    ).category,
  ).toEqual(category);
  expect(taskWithSavedAttributes(row, { category: { task: { ...row, category }, at: 1 } }, null).category).toBeNull();
});
test('親なしに移すときは引き継いだ区分を保ち、その後の自分の保存で上書きする', () => {
  const moved = { value: category, at: 2 };
  expect(taskWithSavedAttributes(row, { category: { task: row, at: 1 } }, undefined, moved).category).toEqual(category);
  expect(taskWithSavedAttributes(row, { category: { task: row, at: 3 } }, undefined, moved).category).toBeNull();
});
