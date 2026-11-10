import { loadingEpic, loadingWorkspace } from './loading-fixture.ts';
export type Reading = { name: string; secondary: boolean; input: Record<string, unknown>; global: boolean };
const op = (name: string, input: Record<string, unknown> = {}, secondary = false, global = false): Reading => ({
  name,
  input,
  secondary,
  global,
});
const ws = { workspace_id: loadingWorkspace };
const w = (name: string, secondary = false) => op(name, ws, secondary);
export type Screen = { route: string; operations: Reading[]; operator?: boolean; note?: string; after?: Reading[] };
// 通常の管理者の成功経路。条件分岐は行を分ける。レイアウトはページと分けて測る。
export const screens: Screen[] = [
  { route: '/', operations: [op('my-organizations', {}, false, true)] },
  { route: '/auth/setup', operations: [op('onboarding-status', {}, false, true), op('me', {}, false, true)] },
  { route: '/operator', operator: true, operations: [op('list-organizations', {}, false, true)] },
  {
    route: '/[slug]/+layout',
    operations: [
      op('organization'),
      op('my-organizations', {}, false, true),
      op('token-notice', {}, true, true),
      op('favorite-list'),
    ],
  },
  {
    route: '/[slug]/+layout（招待あり）',
    operations: [
      op('organization'),
      op('my-organizations', {}, false, true),
      op('token-notice', {}, true, true),
      op('favorite-list'),
    ],
    after: [op('invitation-list', {}, true)],
    note: '並列群の完了後に招待の件数を読む条件分岐を再現する。',
  },
  { route: '/[slug]', operations: [op('today'), op('first-steps', {}, true)] },
  { route: '/[slug]/admin', operations: [], note: 'parent() の権限確認だけ。節の部品の読み込みは load 外。' },
  {
    route: '/[slug]/invitations',
    operations: [op('invitation-list')],
    note: '組織に入れる管理者。招待だけの人は親の結果を再利用。',
  },
  {
    route: '/[slug]/me',
    operations: [
      op('experience-summary'),
      op('experience-grants'),
      op('token-list', {}, false, true),
      op('invitation-list'),
      op('me', {}, false, true),
    ],
  },
  { route: '/[slug]/w/[id]/+layout', operations: [w('workspace')] },
  {
    route: '/[slug]/w/[id]',
    operations: [
      w('backlog-tree'),
      w('category-repository-list', true),
      w('experience-team-total', true),
      op('delegatee-list', {}, true),
    ],
    note: 'delegatee-list は自分用の組織だけ parent() の後に読む。',
  },
  { route: '/[slug]/w/[id]/plan', operations: [w('sprint-list'), w('plan-summary', true)] },
  { route: '/[slug]/w/[id]/sprint', operations: [w('sprint-board')] },
  {
    route: '/[slug]/w/[id]/settings',
    operations: [w('category-repository-list'), w('column-list'), w('detail-field-list')],
    note: 'parent() 後の並列群。',
  },
  { route: '/[slug]/w/[id]/members', operations: [w('member-list')] },
  { route: '/[slug]/w/[id]/inbox', operations: [w('inbox-list')] },
  { route: '/[slug]/w/[id]/connections', operations: [w('connection-list')] },
  {
    route: '/[slug]/w/[id]/epics/[epicId]',
    operations: [op('epic-detail', { ...ws, epic_id: loadingEpic }), w('category-repository-list', true)],
  },
  { route: '/[slug]/wiki', operations: [op('org-wiki-tree')] },
  {
    route: '/[slug]/wiki/[pageId]',
    operations: [op('org-wiki-tree'), op('org-wiki-page', { page_id: '019c0000-0000-7000-8000-000000000001' })],
  },
  { route: '/[slug]/w/[id]/wiki', operations: [w('workspace-wiki-tree')] },
  {
    route: '/[slug]/w/[id]/wiki/[pageId]',
    operations: [
      w('workspace-wiki-tree'),
      op('workspace-wiki-page', { ...ws, page_id: '019c0001-0000-7000-8000-000000000001' }),
    ],
  },
];
