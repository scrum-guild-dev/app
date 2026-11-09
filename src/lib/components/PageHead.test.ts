import { createRawSnippet } from 'svelte';
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

test('補助集計があれば、未完了件数を外に残し、ボタンが指す領域に補助の数字を置く', () => {
  const { body } = render(PageHead, {
    props: { title: 'バックログ', narrowSummary: '集計', tallies: [open, { label: '未見積もり', count: 3 }] },
  });
  expect(body).toContain('is-compact');
  expect(body).toContain('aria-expanded="false"');
  const id = /aria-controls="([^"]+)"/.exec(body)![1];
  const content = body.slice(body.indexOf(`id="${id}"`));
  expect(content).toContain('未見積もり');
  expect(content).toContain('<dd>3</dd>');
  expect(content).not.toContain('未完了のタスク');
});

test('補助の件数が無くても、metaがあれば集計ボタンから確認できる', () => {
  const { body } = render(PageHead, {
    props: {
      title: 'バックログ',
      narrowSummary: '集計',
      tallies: [open],
      meta: createRawSnippet(() => ({ render: () => '<p>チーム全体の経験値 42 XP</p>' })),
    },
  });
  expect(body).toContain('is-compact');
  expect(body).toContain('aria-expanded="false"');
  const id = /aria-controls="([^"]+)"/.exec(body)![1];
  expect(body.slice(body.indexOf(`id="${id}"`))).toContain('チーム全体の経験値 42 XP');
});
