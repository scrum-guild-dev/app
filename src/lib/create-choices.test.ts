import { expect, test } from 'vitest';
import { creationChoices, reconcileCreationRefs } from './create-choices.ts';

const story = (id: string, completed_at: string | null = null) => ({ id, title: id, completed_at });
const tree = {
  stories: [story('root'), story('completed-root', '2026-11-10')],
  epics: [
    { completed_at: null, canceled_at: null, stories: [story('nested'), story('completed-nested', '2026-11-10')] },
    { completed_at: '2026-11-10', canceled_at: null, stories: [story('under-completed')] },
    { completed_at: null, canceled_at: '2026-11-10', stories: [story('under-canceled')] },
  ],
  choices: {
    epics: [
      { id: 'live', title: 'live', finished: false },
      { id: 'finished', title: 'finished', finished: true },
    ],
    assignees: [
      { id: 'member', name: '架空の担当', current: true },
      { id: 'left', name: '架空の離脱者', current: false },
    ],
  },
};

test('未完了の親だけを木の順で選べ、離脱した担当を外す', () => {
  const choices = creationChoices(tree);
  expect(choices.stories.map((s) => s.id)).toEqual(['nested', 'root']);
  expect(choices.epics.map((e) => e.id)).toEqual(['live']);
  expect(choices.people.map((p) => p.id)).toEqual(['member']);
});

test('有効な選択は保ち、読み直して消えた親・担当は送信対象から外す', () => {
  const refs = { storyId: 'nested', epicId: 'live', assignee: 'member' };
  expect(reconcileCreationRefs(creationChoices(tree), refs)).toEqual(refs);
  expect(reconcileCreationRefs(creationChoices(null), refs)).toEqual({ storyId: '', epicId: '', assignee: '' });
  expect(
    reconcileCreationRefs(creationChoices(tree), { storyId: 'completed-root', epicId: 'finished', assignee: 'left' }),
  ).toEqual({ storyId: '', epicId: '', assignee: '' });
});
