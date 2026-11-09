<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { NAV_MENU_ID } from '../nav-collapse.svelte.ts';
  import { GO_KEYS, favoriteNavItem, isNavItemCurrent, isWorkspaceId, isWorkspaceRoute, visibleNav } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { organizationLabel } from '../organization-label.ts';
  import { navStripEdges, navStripScrollLeft } from '../nav-strip.ts';
  import type { NavigationWorkspace } from '../workspace-navigation.svelte.ts';
  import Icon from './Icon.svelte';
  import FavoriteLoadStatus from './FavoriteLoadStatus.svelte';
  import { useFavorites } from '../favorites.svelte.ts';
  const favorites = useFavorites();

  // kit.js の navHtml。current は今の画面のパス、slug は今の組織。画面のある項目だけを出す（nav.ts の visibleNav）。
  // アカウントと組織の入口は上の帯の AccountMenu に置く。所属するワークスペースが無い人（hasWorkspace が偽）には、組織の画面だけを出す。
  // workspaceSwitcher は、メニューの対象があれば組織の画面でも渡す。所属していない管理者にも、
  // ワークスペースの節の見出しと、所属するワークスペースへの切り替えを出す。
  // ワークスペースの経路の項目（メンバーなど）は、対象の ID があるときだけ出す。
  // 組織の切り替えはメニューの外（AppShell のブランドの下）に置く。
  // ワークスペースの設定は、対象のリーダーと管理者にだけ出す。
  let {
    current,
    slug,
    hasWorkspace,
    isAdmin,
    workspace,
    workspaceSwitcher,
  }: {
    current: string;
    slug: string;
    hasWorkspace: boolean;
    isAdmin: boolean;
    workspace?: NavigationWorkspace;
    workspaceSwitcher?: Snippet;
  } = $props();

  const favoriteLinks = $derived(
    (favorites?.items ?? [])
      .map((favorite) => ({ favorite, item: favoriteNavItem(resolve('/[slug]', { slug }), favorite) }))
      .filter(({ item }) => item.href !== null),
  );

  // 760px 以下の帯（横に送る .nav）。画面が変わったら今のページの項目が見える位置まで送り、続きがある端に印を付ける（CSS が端を薄くする）。
  // 広い幅の縦の列は横にはみ出さないので、送らず印も付かない
  let nav = $state<HTMLElement>();
  let moreStart = $state(false);
  let moreEnd = $state(false);

  function syncEdges(): void {
    if (!nav) return;
    const edges = navStripEdges(nav.scrollLeft, nav.clientWidth, nav.scrollWidth);
    moreStart = edges.start;
    moreEnd = edges.end;
  }

  // 今の項目が隠れていれば送り、端の印を付け直す
  function scrollToCurrent(): void {
    if (!nav) return;
    const item = nav.querySelector<HTMLElement>('a.nav-item[aria-current="page"]');
    if (item && nav.scrollWidth > nav.clientWidth) {
      const box = nav.getBoundingClientRect();
      const group = nav.querySelector<HTMLElement>('.ws-menu')?.getBoundingClientRect() ?? null;
      const left = navStripScrollLeft(
        { scrollLeft: nav.scrollLeft, left: box.left, width: nav.clientWidth },
        item.getBoundingClientRect(),
        group,
      );
      if (left !== null) nav.scrollLeft = left;
    }
    syncEdges();
  }

  $effect(() => {
    void current;
    void workspace?.id;
    scrollToCurrent();
  });

  // 書体を読み終えると項目の幅が変わるので、送り位置を測り直す
  $effect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) scrollToCurrent();
    });
    return () => {
      live = false;
    };
  });

  // 帯の大きさ（幅を跨いで狭めたとき、回転したとき）と、項目の大きさ（ワークスペースの名前、件数の印、テーマの書体）が
  // 変わったら測り直す。今の項目が見えている間は送らない（手で送るだけでは大きさが変わらないので、送った位置は戻さない）
  // 子の並び（節、お気に入りの一覧の出入り）が変わったら付け直す
  $effect(() => {
    void sections;
    void favoriteLinks;
    void favorites?.loading;
    if (!nav) return;
    const observer = new ResizeObserver(scrollToCurrent);
    observer.observe(nav);
    for (const child of nav.children) observer.observe(child);
    return () => observer.disconnect();
  });

  const sections = $derived(
    visibleNav(undefined, {
      hasWorkspace,
      isAdmin,
      isLeader: workspace?.role === 'leader',
      hasWorkspaceMenu: workspaceSwitcher !== undefined,
      workspaceId: workspace?.id ?? null,
    }),
  );
</script>

<nav
  class="nav"
  id={NAV_MENU_ID}
  bind:this={nav}
  onscroll={syncEdges}
  data-more-start={moreStart ? '' : undefined}
  data-more-end={moreEnd ? '' : undefined}
>
  {#each sections as section (section.heading ?? 'organization')}
    {#if section.heading}<div class="nav-group"><span class="nav-group-label">{t(section.heading)}</span></div>{/if}
    {#if section.slot === 'workspace' && workspaceSwitcher}{@render workspaceSwitcher()}{/if}
    {#each section.items as item (item.label)}
      <!-- ワークスペースの経路は、ID が無ければ行き先が決まらないので描かない（visibleNav も同じ条件で外す） -->
      {@const href = isWorkspaceRoute(item.href)
        ? isWorkspaceId(workspace?.id)
          ? resolve(item.href, { slug, id: workspace.id })
          : null
        : resolve(item.href, { slug })}
      {#if href !== null}
        <a
          class="nav-item"
          class:is-wrapping={item.label === 'orgWiki'}
          {href}
          aria-describedby={GO_KEYS[item.label] === undefined ? undefined : `nav-go-${item.label}`}
          aria-current={isNavItemCurrent(item.label, href, current) ? 'page' : undefined}
        >
          <Icon name={item.icon} /><span class="nav-item-label"
            >{item.label === 'orgWiki'
              ? t('orgWiki', {
                  organization: page.data.organization ? organizationLabel(page.data.organization.organization) : '',
                })
              : t(item.label)}</span
          >
        </a>
        {#if GO_KEYS[item.label] !== undefined}
          <!-- 続けて押すキーは aria-keyshortcuts に書けないので、リンクの説明として伝える（目には見せない） -->
          <span class="visually-hidden" id="nav-go-{item.label}"
            >{t('shortcutGoHint', {
              first: GO_KEYS[item.label]!.split(' ')[0],
              next: GO_KEYS[item.label]!.split(' ')[1],
            })}</span
          >
        {/if}
      {/if}
    {/each}
    {#if section.heading === undefined && favorites && (favorites.loadFailed || favorites.loading || !favorites.available || favoriteLinks.length > 0)}
      <div class="nav-favorites">
        <div class="nav-group"><span class="nav-group-label">{t('favorites')}</span></div>
        <FavoriteLoadStatus
          onrecovered={() =>
            (
              document.getElementById(NAV_MENU_ID)?.querySelector<HTMLAnchorElement>('.nav-favorites a') ??
              document.getElementById(NAV_MENU_ID)?.querySelector<HTMLAnchorElement>('.nav-item')
            )?.focus()}
        />
        {#each favoriteLinks as { favorite, item } (`${favorite.target_type}/${favorite.target_id}`)}
          {#if item.href !== null}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- favoriteNavItem は resolve 済みの組織パスにエンコードした対象だけを足す -->
            <a class="nav-item" href={item.href} title={favorite.title}>
              <Icon name={item.icon} /><span class="nav-item-label">{favorite.title}</span>
            </a>
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
</nav>
