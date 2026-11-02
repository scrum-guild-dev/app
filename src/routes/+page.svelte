<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import CreateMyOrganizationDialog from '../lib/components/CreateMyOrganizationDialog.svelte';
  import Gate from '../lib/components/Gate.svelte';
  import GateSheet from '../lib/components/GateSheet.svelte';
  import LoadFailed from '../lib/components/LoadFailed.svelte';
  import LogoutButton from '../lib/components/LogoutButton.svelte';
  import CreatePersonalOrganizationDialog from '../lib/components/CreatePersonalOrganizationDialog.svelte';
  import { hasPersonalOrganization, organizationLabel } from '../lib/organization-label.ts';
  import { t } from '../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 組織の選択。入れる組織が2つ以上の人と、届いた招待がある人に出す（1つだけで招待も無い人は +page.ts が組織へ移す）。
  // 届いた招待は組織ごとに1件で、押すとその組織の招待の画面（/<slug>/invitations）へ移り、そこで承諾か辞退を選ぶ。
  // 入れる組織も招待も無い人には「入れる組織がありません」と招待を待つ案内を出す（ログインできるので、ここに来る）。
  // 停止した組織だけがある人には、招待を待つ案内の代わりに、下の停止した組織の紙を指す文を出す。
  // 停止していなければ入れた組織が停止しているときは、その名前と、運用者に問い合わせることを別の紙に出す（入れないのでリンクにしない）。
  // 自分用の組織（kind が personal）は、名前の代わりに「自分用」と出す。「自分用を作る」は、入れる組織にも停止した組織にも自分用が無い人だけに出す
  let { data }: PageProps = $props();
  let createDialog = $state<ReturnType<typeof CreateMyOrganizationDialog>>();
  let createDialogOpen = $state(false);
  let personalDialog = $state<ReturnType<typeof CreatePersonalOrganizationDialog>>();
  let personalDialogOpen = $state(false);
  // 自分用は1アカウントに1つ。入れる組織にも停止した組織にも無いときだけ、作る入口を出す
  // （どちらの一覧にも出ない自分用を持つ人、たとえばその組織で無効にされた人には出し、
  // 押すとサーバーが 409 の personal_limit で断り、ダイアログが示す）。
  const canCreatePersonal = $derived(!data.failed && !hasPersonalOrganization([data.organizations, data.suspended]));
</script>

<!-- 自分の組織を作る入口。入れる組織が無く、ほかに進む道が無い人だけ主ボタンにし、ほかは一覧や案内の下の静かな大きさにそろえる -->
{#snippet createAction(primary: boolean)}
  <button
    class="btn"
    class:is-primary={primary}
    class:is-sm={!primary}
    type="button"
    onclick={(event) => createDialog?.show(event.currentTarget)}>{t('createMyOrganizationAction')}</button
  >
{/snippet}

<!-- 自分用の組織を作る入口。主ボタンにはせず、「組織を作る」と同じ静かな大きさで隣に並べる。自分用を持つ人には出さない -->
{#snippet createPersonalAction()}
  {#if canCreatePersonal}
    <button class="btn is-sm" type="button" onclick={(event) => personalDialog?.show(event.currentTarget)}
      >{t('createPersonalOrganizationAction')}</button
    >
  {/if}
{/snippet}

<svelte:head>
  <title>{t('pageTitle', { page: t('organizationChooseTitle'), app: t('appName') })}</title>
</svelte:head>

{#if data.failed}
  <LoadFailed />
{:else}
  <Gate>
    <GateSheet brand title={t('organizationChooseTitle')}>
      {#if data.organizations.length > 0}
        <p>{t('organizationChooseLead', { count: data.organizations.length })}</p>
        <div class="choice-list">
          {#each data.organizations as organization (organization.slug)}
            <a class="choice" href={resolve('/[slug]', { slug: organization.slug })}>
              <div>
                <b>{organizationLabel(organization)}</b>
                <span class="mono">{page.url.host}/{organization.slug}/</span>
              </div>
            </a>
          {/each}
        </div>
        <p class="gate-note">{t('organizationChooseNote')}</p>
      {:else if data.invitations.length > 0}
        <EmptyState icon="shield" title={t('noOrganizationInvitedTitle')} text={t('noOrganizationInvitedText')} />
      {:else if data.suspended.length > 0}
        <EmptyState
          icon="shield"
          title={t('noOrganizationTitle')}
          text={t('noOrganizationSuspendedText', { organization: t('organization') })}
        >
          {#snippet actions()}{@render createAction(false)}{@render createPersonalAction()}{/snippet}
        </EmptyState>
      {:else}
        <EmptyState
          icon="shield"
          title={t('noOrganizationTitle')}
          text={t('noOrganizationText', { organization: t('organization'), personal: t('personalOrganizationName') })}
        >
          {#snippet actions()}{@render createAction(true)}{@render createPersonalAction()}{/snippet}
        </EmptyState>
      {/if}
      {#if data.organizations.length > 0 || data.invitations.length > 0}
        <div class="form-actions">{@render createAction(false)}{@render createPersonalAction()}</div>
      {/if}
      <div class="form-actions">
        {#if data.operator}
          <a class="btn is-sm" href={resolve('/operator')}>{t('operatorOpen')}</a>
        {/if}
        <LogoutButton />
      </div>
    </GateSheet>
    {#if data.invitations.length > 0}
      <GateSheet title={t('invitationsHeading')}>
        <div class="choice-list">
          {#each data.invitations as invitation (invitation.slug)}
            <a class="choice" href={resolve('/[slug]/invitations', { slug: invitation.slug })}>
              <div>
                <b>{invitation.organization_name}</b>
                <span>{t('invitationPending')}</span>
              </div>
            </a>
          {/each}
        </div>
        <p class="gate-note">{t('invitationsNote')}</p>
      </GateSheet>
    {/if}
    {#if data.suspended.length > 0}
      <GateSheet title={t('suspendedOrganizationsHeading', { organization: t('organization') })}>
        <div class="choice-list">
          {#each data.suspended as organization (organization.slug)}
            <div class="choice is-static">
              <div>
                <b>{organizationLabel(organization)}</b>
                <span>{t('suspendedOrganizationStatus')}</span>
              </div>
            </div>
          {/each}
        </div>
        <p class="gate-note">{t('suspendedOrganizationsNote', { organization: t('organization') })}</p>
      </GateSheet>
    {/if}
  </Gate>
{/if}

<CreateMyOrganizationDialog bind:this={createDialog} bind:open={createDialogOpen} />
<CreatePersonalOrganizationDialog bind:this={personalDialog} bind:open={personalDialogOpen} />
