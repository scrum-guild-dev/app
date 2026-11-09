<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { workspaceViewOf } from '../workspace.ts';
  import { useFavorites, type Favorite } from '../favorites.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  let {
    targetType,
    targetId,
    title,
    workspaceId,
  }: { targetType: Favorite['target_type']; targetId: string; title: string; workspaceId: string | null } = $props();
  const favorites = useFavorites();
  const errorId = $props.id();
  let failure = $state<{ id: string; message: string } | null>(null);
  const marked = $derived(favorites?.marked(targetType, targetId) ?? false);
  const identity = $derived(`${targetType}/${targetId}`);
  async function toggle() {
    const id = identity;
    failure = null;
    const result = await favorites?.toggle({
      target_type: targetType,
      target_id: targetId,
      workspace_id: workspaceId,
      title,
      menuVisible: workspaceViewOf(page.data)?.closedAt == null,
    });
    if (result && !result.ok)
      failure = { id, message: t(result.error?.code === 'favorite_limit' ? 'favoriteLimit' : 'favoriteFailed') };
  }
</script>

{#if favorites}
  <span class="favorite-control">
    <button
      class="favorite-mark"
      type="button"
      aria-pressed={marked}
      aria-label={t('favoriteAdd')}
      title={t(marked ? 'favoriteRemove' : 'favoriteAdd')}
      aria-disabled={!favorites.available || favorites.busy(targetType, targetId)}
      aria-describedby={!favorites.available || failure?.id === identity ? errorId : undefined}
      onclick={toggle}><Icon name="star" /></button
    >
    {#if !favorites.available}
      <span id={errorId} class="field-error">{t('favoriteLoadFailed')}</span>
      <button class="btn is-sm" type="button" onclick={() => invalidate('app:favorites')}>{t('retry')}</button>
    {:else if failure?.id === identity}<span id={errorId} class="field-error" role="alert">{failure.message}</span>{/if}
  </span>
{/if}
