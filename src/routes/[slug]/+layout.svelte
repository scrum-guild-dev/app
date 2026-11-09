<script lang="ts">
  import { provideFavorites } from '../../lib/favorites.svelte.ts';
  import { onMount, type Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import AccountMenu from '../../lib/components/AccountMenu.svelte';
  import AppShell from '../../lib/components/AppShell.svelte';
  import CreateMyOrganizationDialog from '../../lib/components/CreateMyOrganizationDialog.svelte';
  import CreatePersonalOrganizationDialog from '../../lib/components/CreatePersonalOrganizationDialog.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import InvitationInbox from '../../lib/components/InvitationInbox.svelte';
  import LoadFailed from '../../lib/components/LoadFailed.svelte';
  import OrganizationSwitcher from '../../lib/components/OrganizationSwitcher.svelte';
  import TokenNotice from '../../lib/components/TokenNotice.svelte';
  import WorkspaceSwitcher from '../../lib/components/WorkspaceSwitcher.svelte';
  import { hasPersonalOrganization, organizationLabel } from '../../lib/organization-label.ts';
  import { applyOrganization } from '../../lib/organization.svelte.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { workspaceViewOf } from '../../lib/workspace.ts';
  import { WorkspaceNavigation } from '../../lib/workspace-navigation.svelte.ts';
  import type { LayoutData } from './$types';

  // 組織の枠。組織の操作の結果で data-theme を当て、左のメニューと上の帯を出す。
  // 組織に入れないときと無いときは、どちらも同じ「見つからない」の画面（どちらかを漏らさない）。
  // 見つからないのは、API が not_found の 404 を返したときだけ。停止しているのは、organization_suspended の 403
  // （停止していなければ入れた人にだけ返る。入れない人は見つからない）。ほかの失敗（通信、5xx、権限）は読み込みの失敗。
  // 招待の画面（InvitationInbox）は枠を持たない。組織に入れず招待だけがある人にはどの経路でも出し、
  // /<slug>/invitations のページは組織に入れる人にも枠を出さずに出す
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const organization = $derived(data.organization);
  const emptyFavorites: import('../../lib/favorites.svelte.ts').Favorite[] = [];
  const favorites = provideFavorites(() => ({
    scope: `${data.slug}/${organization?.me.id ?? ''}`,
    slug: data.slug,
    items: data.favorites ?? emptyFavorites,
    marks: data.favoriteMarks,
    requestedAt: data.favoritesRequestedAt,
    available: organization !== null && data.favorites !== null,
  }));
  $effect(() => favorites.sync());
  onMount(() => favorites.watch());
  // 招待の画面。組織に入れず招待だけがある人には、どの経路でも招待の画面を出す（data.invitationInbox）。
  // /<slug>/invitations のページ（page.data に invitationPage がある）は、組織に入れる人にも枠を出さずにページだけを出す
  const inbox = $derived(organization ? null : data.invitationInbox);
  const invitationPage = $derived(page.data.invitationPage !== undefined && (organization !== null || inbox !== null));
  const notFound = $derived(data.failure?.status === 404 && data.failure.code === 'not_found');
  const suspended = $derived(data.failure?.status === 403 && data.failure.code === 'organization_suspended');
  // 今開いているワークスペース（/[slug]/w/[id] の枠が読み込む）。メニューにワークスペースの節を出し、
  // 所属していない管理者には印を出す。ワークスペースの画面の外では null
  const openWorkspace = $derived(workspaceViewOf(page.data));
  const navigation = new WorkspaceNavigation();
  const navigationScope = $derived(`${data.slug}/${organization?.me.id ?? ''}`);
  const navigationWorkspace = $derived(
    organization ? navigation.select(navigationScope, organization.workspaces, openWorkspace) : null,
  );

  $effect(() => {
    navigation.remember(navigationScope, organization?.workspaces ?? [], openWorkspace);
  });

  $effect(() => {
    if (organization) applyOrganization(organization);
  });

  // 切り替えは、入れる組織の一覧が読めたときに出す。入れる組織が1つで招待が無い人も、ここから「組織を作る」と「自分用を作る」を開く
  // （その人は / を開くとこの組織へ移り、組織の選択の画面に届かない）。
  // ダイアログは、メニューを閉じても残るよう、切り替えの外（枠）に置く
  const switcherOrganizations = $derived(data.organizations !== null ? data.organizations.organizations : null);
  // 「自分用を作る」も同じ理由でここが入口になる。入れる組織にも停止した組織にも自分用が無い人にだけ出す
  // （組織の選択の画面と同じ条件。持つが一覧に出ない人は、押すとサーバーが 409 の personal_limit で断り、ダイアログが伝える）
  const canCreatePersonal = $derived(
    data.organizations !== null &&
      !hasPersonalOrganization([data.organizations.organizations, data.organizations.suspended]),
  );
  let createDialog = $state<ReturnType<typeof CreateMyOrganizationDialog>>();
  let createDialogOpen = $state(false);
  let createPersonalDialog = $state<ReturnType<typeof CreatePersonalOrganizationDialog>>();
  let createPersonalDialogOpen = $state(false);
</script>

<!-- 組織の中の画面は、それぞれの題名を持つ。見つからない画面だけが、ここで題名を決める -->
<svelte:head>
  {#if !organization && !inbox && notFound}
    <title>{t('pageTitle', { page: t('organizationNotFoundTitle'), app: t('appName') })}</title>
  {:else if !organization && suspended}
    <title>{t('pageTitle', { page: t('organizationSuspendedTitle'), app: t('appName') })}</title>
  {/if}
</svelte:head>

{#if invitationPage}
  {@render children()}
{:else if inbox}
  <InvitationInbox slug={data.slug} list={inbox} member={false} />
{:else if organization}
  {#snippet organizationSwitcher()}
    {#if switcherOrganizations}
      <OrganizationSwitcher
        organizations={switcherOrganizations}
        currentSlug={data.slug}
        fallbackName={organizationLabel(organization.organization)}
        invited={(data.organizations?.invitations.length ?? 0) > 0}
        {canCreatePersonal}
        oncreate={(trigger) => createDialog?.show(trigger)}
        oncreatepersonal={(trigger) => createPersonalDialog?.show(trigger)}
      />
    {/if}
  {/snippet}
  {#snippet account()}
    <!-- 所属していない管理者がワークスペースの画面を開いているときの印。所属していないことを、画面のどこからでも見て分かるようにする -->
    {#if openWorkspace?.role === null}
      <span class="chip">{t('notMemberAdminChip', { admin: t('admin') })}</span>
    {/if}
    <AccountMenu
      userId={organization.me.id}
      name={organization.me.name}
      isAdmin={organization.me.is_admin}
      level={organization.me.level}
      slug={data.slug}
      invitationCount={data.invitationCount}
    />
  {/snippet}
  {#snippet workspaceSwitcher()}
    {#if navigationWorkspace}
      <WorkspaceSwitcher
        workspaces={organization.workspaces}
        currentWorkspace={navigationWorkspace}
        inWorkspaceScreen={openWorkspace !== null}
        slug={data.slug}
      />
    {/if}
  {/snippet}
  {#snippet notice()}
    {#key navigationScope}
      <TokenNotice notice={data.tokenNotice} slug={data.slug} />
    {/key}
  {/snippet}
  <AppShell
    current={page.url.pathname}
    slug={data.slug}
    hasWorkspace={organization.workspaces.length > 0}
    isAdmin={organization.me.is_admin}
    workspace={navigationWorkspace ?? undefined}
    {organizationSwitcher}
    workspaceSwitcher={navigationWorkspace ? workspaceSwitcher : undefined}
    {account}
    {notice}
  >
    {@render children()}
  </AppShell>
  {#if switcherOrganizations}
    <CreateMyOrganizationDialog bind:this={createDialog} bind:open={createDialogOpen} />
    <CreatePersonalOrganizationDialog bind:this={createPersonalDialog} bind:open={createPersonalDialogOpen} />
  {/if}
{:else if notFound}
  <Gate>
    <GateSheet brand title={t('organizationNotFoundTitle')}>
      <EmptyState icon="search" title={t('organizationNotFoundText')}>
        {#snippet actions()}
          <a class="btn is-sm" href={resolve('/')}>{t('organizationList')}</a>
        {/snippet}
      </EmptyState>
    </GateSheet>
  </Gate>
{:else if suspended}
  <Gate>
    <GateSheet brand title={t('organizationSuspendedTitle')}>
      <EmptyState icon="shield" title={t('organizationSuspendedText')}>
        {#snippet actions()}
          <a class="btn is-sm" href={resolve('/')}>{t('organizationList')}</a>
        {/snippet}
      </EmptyState>
    </GateSheet>
  </Gate>
{:else}
  <LoadFailed />
{/if}
