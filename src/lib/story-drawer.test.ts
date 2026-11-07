import { describe, expect, test } from 'vitest';
import {
  epicFinishedOf,
  parentChoicesOf,
  staleCurrentOf,
  storyFactsFrom,
  storyTreeOf,
  type StoryTree,
} from './story-drawer.ts';

function story(id: string, overrides: Partial<{ completed_at: string | null; open_task_count: number }> = {}) {
  return { id, completed_at: null, open_task_count: 0, ...overrides };
}

const tree: StoryTree = {
  today: '2026-11-06',
  week_start: 1,
  epics: [
    { id: 'e1', completed_at: null, canceled_at: null, stories: [story('s-open', { open_task_count: 2 })] },
    {
      id: 'e2',
      completed_at: '2026-11-01T00:00:00.000Z',
      canceled_at: null,
      stories: [story('s-cleared', { completed_at: '2026-10-30T00:00:00.000Z' })],
    },
    { id: 'e3', completed_at: null, canceled_at: '2026-11-02T00:00:00.000Z', stories: [story('s-canceled')] },
  ],
  stories: [story('s-root', { completed_at: '2026-11-03T00:00:00.000Z' })],
  choices: {
    epics: [
      { id: 'e1', title: '進行中', finished: false },
      { id: 'e2', title: 'クリア済み', finished: true },
      { id: 'e3', title: '中止', finished: true },
    ],
  },
};

describe('storyFactsFrom', () => {
  test('story-get の出力を、完了の帯の値にする', () => {
    expect(
      storyFactsFrom({ completed_at: '2026-11-03T00:00:00.000Z', open_task_count: 0, parent_finished: false }),
    ).toEqual({ completedAt: '2026-11-03T00:00:00.000Z', openTasks: 0, parentFinished: false });
    expect(storyFactsFrom({ completed_at: null, open_task_count: 2, parent_finished: true })).toEqual({
      completedAt: null,
      openTasks: 2,
      parentFinished: true,
    });
  });
});

describe('parentChoicesOf', () => {
  test('完了も中止もしていないエピックだけを返す', () => {
    expect(parentChoicesOf(tree)).toEqual([{ id: 'e1', title: '進行中' }]);
  });

  test('木が無ければ null', () => {
    expect(parentChoicesOf(null)).toBeNull();
  });
});

describe('storyTreeOf', () => {
  test('page.data の木が形に合えば取り出す', () => {
    expect(storyTreeOf({ tree })).toBe(tree);
  });

  test('木が無い、読めなかった（null）、形が違うデータは null', () => {
    expect(storyTreeOf({})).toBeNull();
    expect(storyTreeOf({ tree: null })).toBeNull();
    expect(storyTreeOf({ tree: { epics: [], stories: [] } })).toBeNull();
    expect(storyTreeOf({ tree: { ...tree, today: 3 } })).toBeNull();
    expect(storyTreeOf(null)).toBeNull();
  });
});

describe('staleCurrentOf', () => {
  test('stale の details から、今の値の組を取り出す', () => {
    expect(staleCurrentOf({ reason: 'stale', current: { title: '先に直された題' } })).toEqual({
      title: '先に直された題',
    });
  });

  test('stale でない details と形が違う値は null', () => {
    expect(staleCurrentOf({ reason: 'has_parent' })).toBeNull();
    expect(staleCurrentOf({ reason: 'stale', current: 'x' })).toBeNull();
    expect(staleCurrentOf({ reason: 'stale', current: null })).toBeNull();
    expect(staleCurrentOf(undefined)).toBeNull();
    expect(staleCurrentOf('stale')).toBeNull();
  });
});

describe('epicFinishedOf', () => {
  test('クリアか中止したエピックは真、進行中は偽', () => {
    expect(epicFinishedOf(tree, 'e1')).toBe(false);
    expect(epicFinishedOf(tree, 'e2')).toBe(true);
    expect(epicFinishedOf(tree, 'e3')).toBe(true);
  });

  test('木に無いエピックと、木が無いときは偽', () => {
    expect(epicFinishedOf(tree, 'missing')).toBe(false);
    expect(epicFinishedOf(null, 'e2')).toBe(false);
  });
});
