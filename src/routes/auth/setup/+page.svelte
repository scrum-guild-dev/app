<script lang="ts">
  import LoadFailed from '../../../lib/components/LoadFailed.svelte';
  import OnboardingSetup from '../../../lib/components/OnboardingSetup.svelte';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
</script>

<svelte:head><title>{t('pageTitle', { page: t('onboardingStart'), app: t('appName') })}</title></svelte:head>
{#if data.failed}<LoadFailed />{:else}
  {#key data.teamSlug}
    <OnboardingSetup
      initialStatus={data.status}
      person={data.person}
      initialTeamSlug={data.teamSlug}
      returnTo={data.returnTo}
    />
  {/key}
{/if}
