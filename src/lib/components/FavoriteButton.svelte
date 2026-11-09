<script lang="ts">
  import { page } from '$app/state';
  import { workspaceViewOf } from '../workspace.ts';
  import { useFavorites, type Favorite } from '../favorites.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import FavoriteLoadStatus from './FavoriteLoadStatus.svelte';
  let {
    targetType,
    targetId,
    title,
    workspaceId,
    menuVisible,
  }: {
    targetType: Favorite['target_type'];
    targetId: string;
    title: string;
    workspaceId: string | null;
    menuVisible?: boolean;
  } = $props();
  const favorites = useFavorites();
  const errorId = $props.id();
  const writeErrorId = `${errorId}-write`;
  let star = $state<HTMLButtonElement>();
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
      menuVisible: menuVisible ?? workspaceViewOf(page.data)?.closedAt == null,
    });
    if (result && !result.ok)
      failure = { id, message: t(result.error?.code === 'favorite_limit' ? 'favoriteLimit' : 'favoriteFailed') };
  }
</script>

{#if favorites}
  <span class="favorite-control">
    <button
      bind:this={star}
      class="favorite-mark"
      type="button"
      aria-pressed={marked}
      aria-label={t('favoriteAdd')}
      title={t(marked ? 'favoriteRemove' : 'favoriteAdd')}
      aria-disabled={!favorites.available || favorites.busy(targetType, targetId)}
      aria-busy={favorites.loading || favorites.busy(targetType, targetId)}
      aria-describedby={[
        favorites.loadFailed || !favorites.available ? errorId : '',
        failure?.id === identity ? writeErrorId : '',
      ]
        .filter(Boolean)
        .join(' ') || undefined}
      onclick={toggle}><Icon name="star" /></button
    >
    <FavoriteLoadStatus
      id={favorites.loadFailed || !favorites.available ? errorId : undefined}
      onrecovered={() => star?.focus()}
    />
    {#if failure?.id === identity}<span id={writeErrorId} class="field-error" role="alert">{failure.message}</span>{/if}
  </span>
{/if}
