import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import AppShell from './AppShell.svelte';

vi.mock('$app/state', () => ({
  page: { data: { organization: { organization: { name: '架空の組織', kind: 'team' } } } },
}));
vi.mock('$app/paths', () => ({
  asset: (path: string) => `/${path}`,
  resolve: (route: string, params: { slug: string; id?: string }) =>
    route.replace('[slug]', params.slug).replace('[id]', params.id ?? ''),
}));

// 通知の確認に使うフォーカス先を、普段のマウス操作でも受ける要素に変えない。
test('本文の main は初期状態では tabindex を持たない', () => {
  const body = render(AppShell, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: false,
      isAdmin: false,
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body;
  const main = body.match(/<main\b[^>]*>/)?.[0];
  expect(main).toContain('id="content"');
  expect(main).not.toContain('tabindex');
});
