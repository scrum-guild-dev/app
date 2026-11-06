<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import { NAV_MENU_ID, navState, setNavCollapsed } from '../nav-collapse.svelte.ts';
  import { page } from '$app/state';
  import { accountScreenKey, workspaceIdOf } from '../breadcrumb.ts';
  import { isNavItemCurrent, isWorkspaceId, isWorkspaceRoute, visibleNav } from '../nav.ts';
  import { organizationLabel } from '../organization-label.ts';
  import BrandMark from './BrandMark.svelte';
  import Breadcrumb from './Breadcrumb.svelte';
  import NavMenu from './NavMenu.svelte';
  import Icon from './Icon.svelte';
  import type { NavigationWorkspace } from '../workspace-navigation.svelte.ts';

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

  // パンくず。ワークスペースは、ワークスペースの画面を開いているときだけ出す（組織の画面では、メニューの対象でも出さない）。
  // 画面の名前はメニューの項目から引き、メニューに無いアカウントのメニューの画面だけ別に引く
  const organizationName = $derived(
    page.data.organization ? organizationLabel(page.data.organization.organization) : t('organization'),
  );
  const openWorkspaceId = $derived(workspaceIdOf(current));
  const crumbWorkspace = $derived(
    openWorkspaceId !== null && isWorkspaceId(workspace?.id) && workspace.id === openWorkspaceId ? workspace : null,
  );
  const screenName = $derived.by(() => {
    const sections = visibleNav(undefined, {
      hasWorkspace,
      isAdmin,
      isLeader: workspace?.role === 'leader',
      hasWorkspaceMenu: crumbWorkspace !== null,
      workspaceId: crumbWorkspace?.id ?? null,
    });
    for (const section of sections) {
      for (const item of section.items) {
        const href = isWorkspaceRoute(item.href)
          ? crumbWorkspace
            ? resolve(item.href, { slug, id: crumbWorkspace.id })
            : null
          : resolve(item.href, { slug });
        if (href === null || !isNavItemCurrent(item.label, href, current)) continue;
        return item.label === 'orgWiki' ? t('orgWiki', { organization: organizationName }) : t(item.label);
      }
    }
    const key = accountScreenKey(current, slug);
    return key ? t(key) : null;
  });
  const crumbs = $derived([
    { label: organizationName, href: resolve('/[slug]', { slug }) },
    ...(crumbWorkspace
      ? [{ label: crumbWorkspace.name, href: resolve('/[slug]/w/[id]', { slug, id: crumbWorkspace.id }) }]
      : []),
    ...(screenName ? [{ label: screenName, current: true }] : []),
  ]);
</script>

<div class="app" data-nav-collapsed={navState.collapsed ? 'true' : undefined}>
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
  <div class="sheet">
    <div class="topbar">
      <Breadcrumb {crumbs} />
      {#if assistant}{@render assistant()}{/if}
      {#if account}{@render account()}{/if}
    </div>

    {@render notice?.()}
    <main class="content" id="content">{@render children()}</main>
  </div>
</div>
