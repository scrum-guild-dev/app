import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import NarrowDisclosure from './NarrowDisclosure.svelte';

const html = () =>
  render(NarrowDisclosure, {
    props: { label: '集計', children: createRawSnippet(() => ({ render: () => '<p>補助情報</p>' })) },
  }).body;

test('開閉の向きを視覚で伝えるアイコンをボタン内に残す', () => {
  expect(html()).toMatch(/<button[^>]*>[\s\S]*?#i-chevron[\s\S]*?集計[\s\S]*?<\/button>/);
});

test('初期状態と表示対象の関係を支援技術に伝える', () => {
  const body = html();
  const controlled = /aria-controls="([^"]+)"/.exec(body)![1];
  expect(body).toContain('aria-expanded="false"');
  expect(body).toContain(`id="${controlled}"`);
  expect(body).toContain('補助情報');
});
