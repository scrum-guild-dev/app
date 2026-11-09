<script lang="ts">
  import { tick } from 'svelte';
  import { useFavorites } from '../favorites.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  let { id, onrecovered }: { id?: string; onrecovered?: () => void } = $props();
  const favorites = useFavorites();
  async function retry(event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
    if (!favorites || favorites.loading) return;
    const focused = document.activeElement === event.currentTarget;
    await favorites.refresh();
    if (focused && favorites.available && !favorites.loadFailed) {
      await tick();
      onrecovered?.();
    }
  }
</script>

{#if favorites}
  {#if favorites.loadFailed || !favorites.available}
    <span {id} class="field-error">{t('favoriteLoadFailed')}</span>
    <button class="btn is-sm" type="button" aria-disabled={favorites.loading} onclick={retry}>{t('retry')}</button>
  {/if}
  <span class="field-hint" role="status"
    >{favorites.loading ? t('retrying') : favorites.loadFailed ? t('retryFailed') : ''}</span
  >
{/if}
