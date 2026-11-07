<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { NAV_MENU_ID } from '../nav-collapse.svelte.ts';
  import { GO_KEYS, isNavItemCurrent, isWorkspaceId, isWorkspaceRoute, visibleNav } from '../nav.ts';
  import { ariaKeyshortcuts } from '../shortcut-keys.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { organizationLabel } from '../organization-label.ts';
  import type { NavigationWorkspace } from '../workspace-navigation.svelte.ts';
  import Icon from './Icon.svelte';

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

<nav class="nav" id={NAV_MENU_ID}>
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
          aria-keyshortcuts={GO_KEYS[item.label] === undefined ? undefined : ariaKeyshortcuts(GO_KEYS[item.label]!)}
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
      {/if}
    {/each}
  {/each}
</nav>
