import type { DictionaryKey } from '../shared/vocabulary.ts';
import type { IconName } from './icons.ts';

// メニューの行き先。NavMenu が slug（ワークスペースの経路はワークスペースの ID も）で resolve する。
// ワークスペースの経路（WorkspaceNavRoute）は、メニューの対象の ID があるときだけ出す（組織の画面も同じ）
const workspaceRoutes = [
  '/[slug]/w/[id]',
  '/[slug]/w/[id]/members',
  '/[slug]/w/[id]/plan',
  '/[slug]/w/[id]/settings',
  '/[slug]/w/[id]/sprint',
  '/[slug]/w/[id]/wiki',
] as const;
export type WorkspaceNavRoute = (typeof workspaceRoutes)[number];
export type NavRoute = '/[slug]' | '/[slug]/wiki' | WorkspaceNavRoute;

// `g` の次のキーで移る画面。メニューの項目の label から引く（AppShell が登録し、NavMenu が aria-keyshortcuts に伝える）
export const GO_KEYS: Partial<Record<DictionaryKey, string>> = {
  backlog: 'g b',
  sprint: 'g s',
  pageToday: 'g t',
};

export function isWorkspaceRoute(route: NavRoute): route is WorkspaceNavRoute {
  return (workspaceRoutes as readonly string[]).includes(route);
}

// ワークスペースの経路を resolve できる ID か。空の文字列は、/aoba/w//members のような壊れたリンクになるので ID と見ない。
// visibleNav（項目を残すか）と NavMenu（リンクを作るか）が同じ判定を使う
export function isWorkspaceId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id !== '';
}

// メニューの項目。kit.js の PAGES と同じ並びと見出し。
// href が null の項目は、画面がまだ無いのでメニューに出さない（色を薄くして押せなくする形は、
// 状態が色だけに頼り、コントラストも足りないので採らない）。画面を足したら href に経路の ID を入れる。
// leaderOnly の項目は、メニューの対象ワークスペースのリーダーと管理者にだけ出す
export type NavItem = {
  icon: IconName;
  label: DictionaryKey;
  href: NavRoute | null;
  leaderOnly?: true;
};

// slot は、見出しのすぐ下に置く切り替え（組織、ワークスペース）。ワークスペースのメニューを出すときは、
// 項目が無くても見出しと slot の中身（今のワークスペース）を出す。
// inWorkspace は、ワークスペースの中の画面の見出し。所属するワークスペースが無い人（最初のワークスペースを作る前の管理者）には出さない
export type NavSection = {
  heading?: DictionaryKey;
  slot?: 'workspace';
  inWorkspace?: true;
  items: NavItem[];
};

export type VisibleNavItem = { icon: IconName; label: DictionaryKey; href: NavRoute };
export type VisibleNavSection = Omit<NavSection, 'items'> & { items: VisibleNavItem[] };

export type VisibleNavOptions = {
  // ワークスペースの中の見出しを出すか
  hasWorkspace?: boolean;
  isAdmin?: boolean;
  // メニューの対象ワークスペースのリーダー
  isLeader?: boolean;
  // ワークスペースのメニューを出す。項目の無い slot の見出しも出す
  hasWorkspaceMenu?: boolean;
  // メニューの対象ワークスペースの ID。無いときは、ワークスペースの経路の項目を出さない
  workspaceId?: string | null;
};

// 画面のある項目だけを残す。項目が1つも無い見出しは、見出しごと外す（ワークスペースのメニューを出すときの slot を除く）
export function visibleNav(
  sections: NavSection[] = navSections,
  {
    hasWorkspace = true,
    isAdmin = false,
    isLeader = false,
    hasWorkspaceMenu = false,
    workspaceId = null,
  }: VisibleNavOptions = {},
): VisibleNavSection[] {
  return sections
    .filter((section) => hasWorkspace || hasWorkspaceMenu || !section.inWorkspace)
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item): item is VisibleNavItem =>
          item.href !== null &&
          (!item.leaderOnly || isAdmin || isLeader) &&
          (!isWorkspaceRoute(item.href) || (hasWorkspaceMenu && isWorkspaceId(workspaceId))),
      ),
    }))
    .filter((section) => section.items.length > 0 || (hasWorkspaceMenu && section.slot !== undefined));
}

// 今の画面を指す項目か。NavMenu の aria-current とパンくずが同じ判定を使う。
// Wiki は下の階層（ページ）でも、その項目を今の画面とする
export function isNavItemCurrent(label: DictionaryKey, href: string, current: string): boolean {
  return current === href || ((label === 'wiki' || label === 'orgWiki') && current.startsWith(href + '/'));
}

export const navSections: NavSection[] = [
  {
    items: [
      { icon: 'sun', label: 'pageToday', href: '/[slug]' },
      { icon: 'bell', label: 'pageNotifications', href: null },
      { icon: 'file', label: 'orgWiki', href: '/[slug]/wiki' },
    ],
  },
  {
    heading: 'workspace',
    slot: 'workspace',
    inWorkspace: true,
    items: [
      { icon: 'inbox', label: 'inbox', href: null },
      { icon: 'board', label: 'backlog', href: '/[slug]/w/[id]' },
      { icon: 'columns', label: 'sprint', href: '/[slug]/w/[id]/sprint' },
      { icon: 'calendar', label: 'plan', href: '/[slug]/w/[id]/plan' },
      { icon: 'flag', label: 'epic', href: null },
      { icon: 'file', label: 'wiki', href: '/[slug]/w/[id]/wiki' },
    ],
  },
  {
    heading: 'groupRecords',
    inWorkspace: true,
    items: [
      { icon: 'trend', label: 'capacity', href: null },
      { icon: 'check', label: 'pageRecords', href: null },
      { icon: 'archive', label: 'archive', href: null },
    ],
  },
  {
    heading: 'groupManage',
    inWorkspace: true,
    items: [
      { icon: 'link', label: 'connection', href: null },
      { icon: 'users', label: 'pageMembers', href: '/[slug]/w/[id]/members' },
      { icon: 'gear', label: 'pageSettings', href: '/[slug]/w/[id]/settings', leaderOnly: true },
      { icon: 'clock', label: 'pageHistory', href: null },
    ],
  },
];
