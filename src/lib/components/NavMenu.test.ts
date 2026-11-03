import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, expect, test, vi } from 'vitest';
import NavMenu from './NavMenu.svelte';

const { organization } = vi.hoisted(() => ({
  organization: { name: '架空の組織', kind: 'team' as 'team' | 'personal' },
}));

vi.mock('$app/state', () => ({ page: { data: { organization: { organization } } } }));

beforeEach(() => {
  organization.kind = 'team';
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
