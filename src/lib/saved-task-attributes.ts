import type { BacklogTask } from '../shared/operations/task/backlog-tree.ts';
import type { Attribute } from './task-attributes.svelte.ts';

type Saved = Readonly<Partial<Record<Attribute, { task: Pick<BacklogTask, Attribute>; at: number }>>>;
export function taskWithSavedAttributes(
  task: BacklogTask,
  changes: Saved,
  inheritedCategory?: BacklogTask['category'],
  movedToRootAt?: number,
): BacklogTask {
  const result = { ...task };
  for (const field of Object.keys(changes) as Attribute[]) {
    const saved = changes[field];
    if (saved !== undefined) Object.assign(result, { [field]: saved.task[field] });
  }
  if (inheritedCategory !== undefined) result.category = inheritedCategory;
  else if (movedToRootAt !== undefined && (changes.category?.at ?? -Infinity) <= movedToRootAt) {
    result.category = null;
  }
  return result;
}
