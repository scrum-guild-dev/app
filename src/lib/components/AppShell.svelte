<script lang="ts">
  import CreateSheet from './CreateSheet.svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import MobileNavigation from './MobileNavigation.svelte';
  import { navigationLoading } from '../navigation-loading.svelte.ts';
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import { NAV_MENU_ID, navState, setNavCollapsed } from '../nav-collapse.svelte.ts';
  import { page } from '$app/state';
  import { accountScreenKey, workspaceIdOf } from '../breadcrumb.ts';
  import { goto } from '$app/navigation';
  import { useShortcut } from '../shortcuts.svelte.ts';
  import { GO_KEYS, isNavItemCurrent, isWorkspaceId, isWorkspaceRoute, visibleNav } from '../nav.ts';
  import { organizationLabel } from '../organization-label.ts';
  import BrandMark from './BrandMark.svelte';
  import Breadcrumb from './Breadcrumb.svelte';
  import NavMenu from './NavMenu.svelte';
  import NavSearch from './NavSearch.svelte';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import Icon from './Icon.svelte';
  import type { NavigationWorkspace } from '../workspace-navigation.svelte.ts';

  const createSheetId = $props.id();
  let createSheet = $state<ReturnType<typeof CreateSheet>>();

  // kit.js の mount が組む画面の枠。左上の角のマス（ロゴ）と全幅の上の帯が十字に分かれ、左のメニュー（綴じ）と本文（帳面）が続く。
  // slug は今の組織で、組織の中の画面だけが使う。
  // 組織の切り替え（ブランドの下）、ワークスペースの切り替え、アシスタントのボタンは置き場所だけで、中身は snippet で渡す。
  // workspace はメニューの対象。「今日やること」など組織の画面でも渡す。
  // 上の帯の左はパンくず（組織 › ワークスペース › 画面）で、常に出す。assistant と account は右に並べる。account はログインしている人の表示
  let {
    current,
    slug,
    hasWorkspace,
    isAdmin,
    workspace,
    organizationSwitcher,
    workspaceSwitcher,
    assistant,
    account,
    notice,
    children,
  }: {
    current: string;
    slug: string;
    hasWorkspace: boolean;
    isAdmin: boolean;
    workspace?: NavigationWorkspace;
    organizationSwitcher?: Snippet;
    workspaceSwitcher?: Snippet;
    assistant?: Snippet;
    account?: Snippet;
    notice?: Snippet;
    children: Snippet;
  } = $props();

  const narrow = new MediaQuery('(max-width: 760px)');

  // パンくず。ワークスペースは、ワークスペースの画面を開いているときだけ出す（組織の画面では、メニューの対象でも出さない）。
  // 画面の名前はメニューの項目から引き、メニューに無いアカウントのメニューの画面だけ別に引く
  const organizationName = $derived(
    page.data.organization ? organizationLabel(page.data.organization.organization) : t('organization'),
  );
  const openWorkspaceId = $derived(workspaceIdOf(current));
  const crumbWorkspace = $derived(
    openWorkspaceId !== null && isWorkspaceId(workspace?.id) && workspace.id === openWorkspaceId ? workspace : null,
  );
  // 画面の名前と行き先。パンくずの今の画面と、上の帯の検索の候補が同じ一覧を使う
  const navScreens = $derived.by(() => {
    const sections = visibleNav(undefined, {
      hasWorkspace,
      isAdmin,
      isLeader: workspace?.role === 'leader',
      hasWorkspaceMenu: crumbWorkspace !== null,
      workspaceId: crumbWorkspace?.id ?? null,
    });
    const screens: { key: DictionaryKey; label: string; href: string }[] = [];
    for (const section of sections) {
      for (const item of section.items) {
        const href = isWorkspaceRoute(item.href)
          ? crumbWorkspace
            ? resolve(item.href, { slug, id: crumbWorkspace.id })
            : null
          : resolve(item.href, { slug });
        if (href === null) continue;
        screens.push({
          key: item.label,
          label: item.label === 'orgWiki' ? t('orgWiki', { organization: organizationName }) : t(item.label),
          href,
        });
      }
    }
    return screens;
  });
  // `g` の次のキーで、バックログ・スプリント・今日やることへ移る（shortcuts.svelte.ts に登録する）。
  // バックログとスプリントは、メニューの対象のワークスペースがあるときだけ。今いる画面へは移らない
  const goHref = (key: 'backlog' | 'sprint' | 'pageToday'): string | null => {
    if (key === 'pageToday') return resolve('/[slug]', { slug });
    if (!isWorkspaceId(workspace?.id)) return null;
    return key === 'backlog'
      ? resolve('/[slug]/w/[id]', { slug, id: workspace.id })
      : resolve('/[slug]/w/[id]/sprint', { slug, id: workspace.id });
  };
  for (const key of ['backlog', 'sprint', 'pageToday'] as const) {
    useShortcut(() => ({
      id: `go-${key}`,
      keys: GO_KEYS[key]!,
      label: () => t('shortcutGo', { screen: t(key) }),
      global: true,
      helpOrder: 2,
      enabled: () => {
        const href = goHref(key);
        return href !== null && href !== current;
      },
      run: () => {
        if (key === 'pageToday') void goto(resolve('/[slug]', { slug }));
        else if (isWorkspaceId(workspace?.id))
          void goto(
            key === 'backlog'
              ? resolve('/[slug]/w/[id]', { slug, id: workspace.id })
              : resolve('/[slug]/w/[id]/sprint', { slug, id: workspace.id }),
          );
      },
    }));
  }
  // 検索から送るバックログ。ワークスペースの画面を開いているときだけ
  const backlogHref = $derived(crumbWorkspace ? resolve('/[slug]/w/[id]', { slug, id: crumbWorkspace.id }) : null);
  const screenName = $derived.by(() => {
    const found = navScreens.find((screen) => isNavItemCurrent(screen.key, screen.href, current));
    if (found) return found.label;
    const key = accountScreenKey(current, slug, isAdmin);
    return key ? t(key) : null;
  });
  const crumbs = $derived([
    { label: organizationName, href: resolve('/[slug]', { slug }) },
    ...(crumbWorkspace
      ? [{ label: crumbWorkspace.name, href: resolve('/[slug]/w/[id]', { slug, id: crumbWorkspace.id }) }]
      : []),
    ...(screenName ? [{ label: screenName, current: true }] : []),
  ]);
  // 画面の名前が決まらない画面（エピックやタスクの詳細など）では、最後の項目（ワークスペース）を今の画面として示す。リンクは残し、戻れるようにする
  const shownCrumbs = $derived(
    screenName ? crumbs : crumbs.map((crumb, i) => (i === crumbs.length - 1 ? { ...crumb, current: true } : crumb)),
  );
</script>

<div class="app" data-nav-collapsed={navState.collapsed ? 'true' : undefined}>
  {#if !narrow.current}
    <aside class="binding" aria-label={t('menu')}>
      <div class="binding-inner">
        <div class="binding-head">
          <a class="brand" href={resolve('/[slug]', { slug })}>
            <BrandMark />
            <span class="visually-hidden">{t('appName')}</span>
          </a>
          <button
            class="nav-toggle"
            type="button"
            aria-expanded={!navState.collapsed}
            aria-controls={NAV_MENU_ID}
            aria-label={t(navState.collapsed ? 'menuExpand' : 'menuCollapse')}
            onclick={() => setNavCollapsed(!navState.collapsed)}
          >
            <Icon name="panel" />
            <span class="nav-tip" aria-hidden="true">{t(navState.collapsed ? 'menuExpand' : 'menuCollapse')}</span>
          </button>
        </div>
        <div class="binding-body">
          {#if organizationSwitcher}{@render organizationSwitcher()}{/if}
          <NavMenu {current} {slug} {hasWorkspace} {isAdmin} {workspace} {workspaceSwitcher} />
        </div>
      </div>
    </aside>
  {/if}
  <div class="sheet">
    <div class="topbar">
      <Breadcrumb crumbs={shownCrumbs} />
      <NavSearch screens={navScreens} {backlogHref} />
      {#if assistant}{@render assistant()}{/if}
      {#if account}{@render account()}{/if}
    </div>

    {@render notice?.()}
    <main class="content" id="content" aria-busy={navigationLoading.kind === 'inside' ? true : undefined}>
      {@render children()}
    </main>
  </div>
  {#if narrow.current}
    <MobileNavigation
      {createSheetId}
      oncreate={(trigger) => createSheet?.show(trigger)}
      {current}
      {slug}
      workspaceId={hasWorkspace ? workspace?.id : undefined}
      {organizationSwitcher}
    >
      {#snippet menu()}
        <NavMenu {current} {slug} {hasWorkspace} {isAdmin} {workspace} {workspaceSwitcher} />
      {/snippet}
    </MobileNavigation>
  {/if}
  {#if hasWorkspace && isWorkspaceId(workspace?.id)}
    {#key `${slug}/${workspace.id}`}<CreateSheet
        bind:this={createSheet}
        {slug}
        workspaceId={workspace.id}
        id={createSheetId}
      />{/key}
  {/if}
</div>
