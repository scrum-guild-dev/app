import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import AppShell from './AppShell.svelte';
import { navigationLoading } from '../navigation-loading.svelte.ts';

vi.mock('$app/state', () => ({
  page: { data: { organization: { organization: { name: '架空の組織', kind: 'team' } } } },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn(), invalidate: vi.fn() }));
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

const shell = (current: string, workspace?: { id: string; name: string; role: 'leader' | 'member' }) =>
  render(AppShell, {
    props: {
      current,
      slug: 'aoba',
      hasWorkspace: true,
      isAdmin: false,
      workspace,
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body;

test('組織の画面のパンくずは組織と画面だけで、ワークスペースを出さない', () => {
  const body = shell('/aoba', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav).toContain('aria-label="パンくず"');
  expect(nav).toContain('架空の組織');
  expect(nav).toContain('今日やること');
  expect(nav).not.toContain('ふくろう班');
  expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
});

test('ワークスペースの画面のパンくずは組織、ワークスペース、画面の順で、今の画面だけが aria-current', () => {
  const body = shell('/aoba/w/w1/sprint', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav.indexOf('架空の組織')).toBeLessThan(nav.indexOf('ふくろう班'));
  expect(nav.indexOf('ふくろう班')).toBeLessThan(nav.indexOf('スプリント'));
  expect(nav).toContain('href="/aoba/w/w1"');
  expect(nav).toMatch(/<span[^>]*aria-current="page"[^>]*>スプリント<\/span>/);
});

test('画面の名前が決まらない画面では、最後の項目を今の画面にし、戻れるようリンクは残す', () => {
  const body = shell('/aoba/w/w1/tasks/t1', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav).toMatch(/<a[^>]*aria-current="page"[^>]*>ふくろう班<\/a>/);
  expect(nav).toContain('href="/aoba/w/w1"');
});

test('Wiki の下の階層でも Wiki を今の画面にし、メニューに無い画面はアカウントの画面の名前を引く', () => {
  expect(shell('/aoba/w/w1/wiki/page-1', { id: 'w1', name: 'ふくろう班', role: 'member' })).toMatch(
    /<span[^>]*aria-current="page"[^>]*>Wiki<\/span>/,
  );
  expect(shell('/aoba/me')).toMatch(/<span[^>]*aria-current="page"[^>]*>マイプロフィール<\/span>/);
});

test('URL のワークスペースとメニューの対象が食い違うときは、対象の名前をパンくずに出さない', () => {
  const body = shell('/aoba/w/w2/sprint', { id: 'w1', name: 'ふくろう班', role: 'member' });
  const nav = body.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] ?? '';
  expect(nav).not.toContain('ふくろう班');
});

test('上の帯に検索の欄があり、ワークスペースの画面ではバックログの検索の行き先を持つ', () => {
  const body = render(AppShell, {
    props: {
      current: '/aoba',
      slug: 'aoba',
      hasWorkspace: false,
      isAdmin: false,
      children: createRawSnippet(() => ({ render: () => '<p>架空の本文</p>' })),
    },
  }).body;
  expect(body).toMatch(/<input[^>]*role="combobox"[^>]*aria-label="画面とタスクを探す"/);
  expect(body).toContain('aria-keyshortcuts="Control+K Meta+K"');
});

test('枠の中の遅い移動だけ本文をbusyにし、操作を止めない', () => {
  try {
    for (const kind of [null, 'outside', 'inside'] as const) {
      navigationLoading.kind = kind;
      const body = shell('/aoba');
      const main = body.match(/<main\b[^>]*>/)?.[0] ?? '';
      expect(main.includes('aria-busy="true"')).toBe(kind === 'inside');
      expect(main).not.toContain('inert');
      expect(main).not.toContain('aria-hidden');
    }
  } finally {
    navigationLoading.kind = null;
  }
});
