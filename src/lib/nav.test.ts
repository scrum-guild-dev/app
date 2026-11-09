import { expect, test } from 'vitest';
import { favoriteNavItem, visibleNav } from './nav.ts';

test.each([false, true])(
  'ワークスペースの有無（%s）によらず、左のメニューにアカウントと組織の入口を出さない',
  (hasWorkspace) => {
    for (const hasWorkspaceMenu of [false, true]) {
      for (const isAdmin of [false, true]) {
        const labels = visibleNav(undefined, {
          hasWorkspace,
          hasWorkspaceMenu,
          isAdmin,
          workspaceId: 'w1',
        }).flatMap((section) => section.items.map((item) => item.label));
        expect(labels).not.toContain('pageMe');
        expect(labels).not.toContain('pageOrgAdmin');
        if (!hasWorkspaceMenu) expect(labels).toEqual(['pageToday', 'orgWiki']);
      }
    }
  },
);

test('ワークスペースの設定は、管理者かリーダーのときだけ残す', () => {
  const labels = (options: { isAdmin?: boolean; isLeader?: boolean }) =>
    visibleNav(undefined, {
      hasWorkspace: false,
      hasWorkspaceMenu: true,
      workspaceId: 'w1',
      ...options,
    }).flatMap((section) => section.items.map((item) => item.label));
  expect(labels({ isAdmin: true })).toContain('pageSettings');
  expect(labels({ isLeader: true })).toContain('pageSettings');
  expect(labels({})).not.toContain('pageSettings');
});

test('お気に入りはアプリのbaseを保ち、対象の種類とworkspaceで行き先を分ける', () => {
  const row = { id: 'mark', target_id: '対象/1', workspace_id: 'w 1', title: '題', created_at: '' };
  for (const [target_type, suffix, icon] of [
    ['task', '/w/w%201/tasks/対象%2F1', 'check'],
    ['story', '/w/w%201?story=対象%2F1', 'board'],
    ['epic', '/w/w%201/epics/対象%2F1', 'flag'],
    ['wiki_page', '/w/w%201/wiki/対象%2F1', 'file'],
  ] as const) {
    const result = favoriteNavItem('/base/aoba', { ...row, target_type });
    expect(result).toEqual({ href: '/base/aoba' + suffix.replace('対象', encodeURIComponent('対象')), icon });
  }
  expect(favoriteNavItem('/base/aoba', { ...row, workspace_id: null, target_type: 'wiki_page' }).href).toBe(
    '/base/aoba/wiki/' + encodeURIComponent('対象/1'),
  );
});
