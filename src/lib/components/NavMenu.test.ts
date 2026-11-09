import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, expect, test, vi } from 'vitest';
import NavMenu from './NavMenu.svelte';
import type { Favorite } from '../favorites.svelte.ts';

const { organization, favoriteState } = vi.hoisted(() => ({
  favoriteState: {
    current: undefined as
      { available: boolean; items: Favorite[]; loadFailed?: boolean; loading?: boolean } | undefined,
  },
  organization: { name: '架空の組織', kind: 'team' as 'team' | 'personal' },
}));

vi.mock('../favorites.svelte.ts', () => ({ useFavorites: () => favoriteState.current }));

vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));

vi.mock('$app/state', () => ({ page: { data: { organization: { organization } } } }));

beforeEach(() => {
  organization.kind = 'team';
  favoriteState.current = undefined;
});

vi.mock('$app/paths', () => ({
  resolve: (route: string, params: { slug: string; id?: string }) =>
    route.replace('[slug]', params.slug).replace('[id]', params.id ?? ''),
}));

const workspace = { id: 'one', name: '架空の開発チーム', role: 'member' as const };
const workspaceSwitcher = createRawSnippet(() => ({ render: () => '<div>架空の切り替え</div>' }));

test('今日やることでも対象のリンクがあり、現在地は今日やることだけ', () => {
  const body = render(NavMenu, {
    props: { current: '/aoba', slug: 'aoba', hasWorkspace: true, isAdmin: false, workspace, workspaceSwitcher },
  }).body;
  expect(body).toContain('架空の切り替え');
  for (const path of ['', '/sprint', '/plan', '/wiki', '/members']) {
    expect(body).toContain(`href="/aoba/w/one${path}"`);
  }
  expect(body).not.toContain('/settings');
  expect(body.match(/aria-current="page"/g)).toHaveLength(1);
  expect(body).toMatch(/href="\/aoba"[^>]*aria-current="page"/);
});

test('設定は対象の今のロールがリーダーか管理者の場合に出す', () => {
  for (const role of ['leader', 'member'] as const) {
    for (const isAdmin of [false, true]) {
      const body = render(NavMenu, {
        props: {
          current: '/aoba',
          slug: 'aoba',
          hasWorkspace: true,
          isAdmin,
          workspace: { ...workspace, role },
          workspaceSwitcher,
        },
      }).body;
      expect(body.includes('/settings')).toBe(isAdmin || role === 'leader');
    }
  }
});

test('対象が無いときも今日やることと組織の Wiki を出す', () => {
  const body = render(NavMenu, {
    props: { current: '/aoba', slug: 'aoba', hasWorkspace: false, isAdmin: true },
  }).body;
  expect(body).not.toContain('/w/');
  expect(body).not.toContain('架空の切り替え');
  expect(body).toContain('href="/aoba/wiki"');
  expect(body).toContain('架空の組織の Wiki');
});

test.each([
  ['team', '架空の組織の Wiki'],
  ['personal', '自分用の Wiki'],
] as const)('組織の Wiki（%s）の現在地と名前を保ち、対象のワークスペースもメニューに残す', (kind, label) => {
  organization.kind = kind;
  const body = render(NavMenu, {
    props: {
      current: '/aoba/wiki/page',
      slug: 'aoba',
      hasWorkspace: true,
      isAdmin: false,
      workspace,
      workspaceSwitcher,
    },
  }).body;
  expect(body).toContain(label);
  expect(body).toMatch(/class="nav-item is-wrapping"[^>]*href="\/aoba\/wiki"[^>]*aria-current="page"/);
  expect(body).toContain('href="/aoba/w/one/wiki"');
  expect(body).toContain('架空の切り替え');
  expect(body.match(/aria-current="page"/g)).toHaveLength(1);
});

test('お気に入りは組織とワークスペースの節の間に、種類・題・全文title付きで出す', () => {
  favoriteState.current = {
    available: true,
    items: [
      {
        id: 'mark',
        target_type: 'story',
        target_id: 'story-one',
        workspace_id: 'one',
        title: '架空のストーリー',
        created_at: '',
      },
    ],
  };
  const body = render(NavMenu, {
    props: { current: '/aoba', slug: 'aoba', hasWorkspace: true, isAdmin: false, workspace, workspaceSwitcher },
  }).body;
  expect(body).toContain('href="/aoba/w/one?story=story-one"');
  expect(body).toContain('title="架空のストーリー"');
  expect(body.indexOf('nav-favorites')).toBeGreaterThan(body.indexOf('href="/aoba/wiki"'));
  expect(body.indexOf('nav-favorites')).toBeLessThan(body.indexOf('架空の切り替え'));
});

test('0件は節を出さず、一覧失敗は0件と分けて説明と再試行を出す', () => {
  const props = { current: '/aoba', slug: 'aoba', hasWorkspace: false, isAdmin: false };
  favoriteState.current = { available: true, items: [] };
  expect(render(NavMenu, { props }).body).not.toContain('nav-favorites');
  favoriteState.current = { available: false, items: [] };
  const body = render(NavMenu, { props }).body;
  expect(body).toContain('お気に入りを読み込めませんでした。');
  expect(body).toContain('もう一度試す');
});

test('リンクにできる対象が無い一覧では見出しだけの節を出さない', () => {
  favoriteState.current = {
    available: true,
    items: [
      { id: 'bad', target_type: 'task', target_id: 'task', workspace_id: null, title: '架空の題', created_at: '' },
    ],
  };
  const body = render(NavMenu, { props: { current: '/aoba', slug: 'aoba', hasWorkspace: false, isAdmin: false } }).body;
  expect(body).not.toContain('nav-favorites');
});
