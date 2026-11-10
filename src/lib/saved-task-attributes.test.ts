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
test('親なしへ移すと親の区分は写さず、その後の自分の保存だけを出す', () => {
  const child = { ...row, category };
  expect(taskWithSavedAttributes(child, {}, undefined, 2).category).toBeNull();
  expect(
    taskWithSavedAttributes(child, { category: { task: { ...row, category }, at: 1 } }, undefined, 2).category,
  ).toBeNull();
  expect(
    taskWithSavedAttributes(child, { category: { task: { ...row, category }, at: 3 } }, undefined, 2).category,
  ).toEqual(category);
});
