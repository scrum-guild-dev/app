<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import EmptyState from '../../../lib/components/EmptyState.svelte';
  import FavoriteLoadStatus from '../../../lib/components/FavoriteLoadStatus.svelte';
  import Icon from '../../../lib/components/Icon.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import { useFavorites, type Favorite } from '../../../lib/favorites.svelte.ts';
  import { favoriteNavItem } from '../../../lib/nav.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { DictionaryKey } from '../../../shared/vocabulary.ts';

  // お気に入りの一覧の画面（見本は design/favorites.html）。一覧は組織の枠が読んだもの（provideFavorites）をそのまま使い、
  // 星を付け外しすると左のメニューと一緒に変わる。行き先の決め方もメニューと同じ favoriteNavItem で、行き先の決まらない対象は出さない
  const favorites = useFavorites();
  const base = $derived(resolve('/[slug]', { slug: page.params.slug ?? '' }));
  const rows = $derived(
    (favorites?.items ?? []).flatMap((favorite) => {
      const { href, icon } = favoriteNavItem(base, favorite);
      return href === null ? [] : [{ favorite, href, icon }];
    }),
  );
  const kindKeys: Record<Favorite['target_type'], DictionaryKey> = {
    task: 'task',
    story: 'story',
    epic: 'epic',
    wiki_page: 'favoriteKindWikiPage',
  };
  const failed = $derived(favorites === undefined || favorites.loadFailed || !favorites.available || favorites.loading);
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('favorites'), app: t('appName') })}</title>
</svelte:head>

<PageHead title={t('favorites')} />

{#if failed}
  <div class="favorite-control"><FavoriteLoadStatus /></div>
{/if}
{#if rows.length > 0}
  <div class="choice-list">
    {#each rows as { favorite, href, icon } (`${favorite.target_type}/${favorite.target_id}`)}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- favoriteNavItem は resolve 済みの組織パスにエンコードした対象だけを足す -->
      <a class="choice" {href}>
        <Icon name={icon} />
        <div>
          <b>{favorite.title}</b>
          <span>{t(kindKeys[favorite.target_type])}</span>
        </div>
        <Icon name="chevron" />
      </a>
    {/each}
  </div>
{:else if !failed}
  <EmptyState
    icon="star"
    title={t('favoritesEmpty')}
    text={t('favoritesEmptyText', { task: t('task'), story: t('story'), epic: t('epic') })}
  />
{/if}
