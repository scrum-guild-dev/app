<script lang="ts">
  import OnboardingPreview from '../../../lib/components/OnboardingPreview.svelte';
  import { t } from '../../../lib/vocabulary.svelte.ts';
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('onboardingPreview'), app: t('appName') })}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<OnboardingPreview />
