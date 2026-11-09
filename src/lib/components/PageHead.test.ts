import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import PageHead from './PageHead.svelte';

const open = { label: '未完了のタスク', count: 8 };

test('補助集計が空なら、開いても何も出ない集計ボタンを置かない', () => {
  for (const tallies of [[], [open]]) {
    const { body } = render(PageHead, { props: { title: 'バックログ', narrowSummary: '集計', tallies } });
    expect(body).not.toContain('aria-expanded');
    if (tallies.length) expect(body).toContain('未完了のタスク');
  }
});

test('集計ボタンを省略しても、見出しと全件数を残す', () => {
  const { body } = render(PageHead, {
    props: { title: 'バックログ', tallies: [open, { label: '未見積もり', count: 3 }] },
  });
  expect(body).toContain('バックログ');
  expect(body).toContain('未完了のタスク');
  expect(body).toContain('未見積もり');
  expect(body).not.toContain('aria-expanded');
});
