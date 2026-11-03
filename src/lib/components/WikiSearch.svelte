<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { callOperation } from '../api.ts';
  import { t } from '../vocabulary.svelte.ts';
  import {
    orgWikiSearch,
    workspaceWikiSearch,
    wikiQuerySchema,
    type WikiSearchResult,
    type WikiNode,
  } from '../../shared/operations/wiki/index.ts';

  let {
    slug,
    workspaceId,
    pages,
    currentId,
    children,
  }: {
    slug: string;
    workspaceId: string | null;
    pages: WikiNode[];
    currentId: string | null;
    children: Snippet<[boolean]>;
  } = $props();
  let query = $state('');
  let results = $state<WikiSearchResult[]>([]);
  let loading = $state(false);
  let searched = $state(false);
  let failure = $state('');
  let retry = $state(0);
  let composing = $state(false);
  let lastIdentity = '';
  const contentVersion = $derived(
    pages
      .map((item) => `${item.id}:${item.version}`)
      .sort()
      .join('|'),
  );
  const searchText = $derived(query.trim());
  const parsed = $derived(wikiQuerySchema.safeParse(searchText));

  $effect(() => {
    const text = searchText;
    const scopeSlug = slug;
    const scopeWorkspace = workspaceId;
    const input = parsed;
    const identity = JSON.stringify([scopeSlug, scopeWorkspace, input.success ? input.data : text]);
    void contentVersion;
    void retry;
    const isComposing = composing;
    const changed = identity !== lastIdentity;
    lastIdentity = identity;
    let active = true;
    if (changed) {
      results = [];
      searched = false;
    }
    failure = text && !input.success ? t('wikiSearchInvalid') : '';
    loading = text.length > 0 && input.success && !isComposing;
    const timer = setTimeout(async () => {
      if (!text || !input.success || isComposing) return;
      const result = scopeWorkspace
        ? await callOperation(
            workspaceWikiSearch,
            { workspace_id: scopeWorkspace, query: input.data },
            { slug: scopeSlug },
          )
        : await callOperation(orgWikiSearch, { query: input.data }, { slug: scopeSlug });
      if (!active) return;
      loading = false;
      searched = true;
      if (result.ok) results = result.data.pages;
      else {
        results = [];
        failure = t(
          result.error?.code === 'rate_limited'
            ? 'wikiSearchRateLimited'
            : result.error?.code === 'wiki_search_limit'
              ? 'wikiSearchLimit'
              : 'wikiSearchFailed',
        );
      }
    }, 800);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  });
  function pathOf(id: string): string {
    const path: string[] = [];
    let parent = pages.find((item) => item.id === id)?.parent_id;
    for (let depth = 0; parent && depth < 10; depth++) {
      const node = pages.find((item) => item.id === parent);
      if (!node) break;
      path.unshift(node.title);
      parent = node.parent_id;
    }
    return [t('wiki'), ...path].join(' / ');
  }
</script>

<form
  class="form"
  role="search"
  aria-label={t('wikiSearch')}
  onsubmit={(event) => {
    event.preventDefault();
    if (!loading) retry += 1;
  }}
>
  <div class="field">
    <label for="wiki-search">{t('wikiSearch')}</label>
    <input
      id="wiki-search"
      class="input"
      type="search"
      bind:value={query}
      oncompositionstart={() => {
        composing = true;
      }}
      oncompositionend={() => {
        composing = false;
      }}
      onblur={() => {
        composing = false;
      }}
      aria-invalid={query.trim() && !parsed.success ? true : undefined}
      aria-describedby={failure ? 'wiki-search-hint wiki-search-error' : 'wiki-search-hint'}
    />
    <p id="wiki-search-hint" class="field-hint">{t('wikiSearchHint')}</p>
  </div>
  <div class="form-actions">
    <button class="btn" type="submit" aria-disabled={loading}>{t('wikiSearchRun')}</button>
  </div>
</form>
<div role="status" aria-live="polite">
  {#if loading}<p class="field-hint">{t('wikiSearching')}</p>
  {:else if failure}<p id="wiki-search-error" class="field-error">{failure}</p>
  {:else if searched}<p class="field-hint">
      {t(results.length ? 'wikiSearchCount' : 'wikiSearchEmpty', { count: results.length })}
    </p>{/if}
</div>
{@render children(Boolean(query.trim()))}
{#if query.trim() && results.length}
  <nav aria-label={t('wikiSearchResults')}>
    <ul class="wiki-tree panel">
      {#each results as item (item.id)}
        <li>
          <a
            class="wiki-link"
            href={workspaceId
              ? resolve('/[slug]/w/[id]/wiki/[pageId]', { slug, id: workspaceId, pageId: item.id })
              : resolve('/[slug]/wiki/[pageId]', { slug, pageId: item.id })}
            aria-current={currentId === item.id ? 'page' : undefined}
            >{item.title}<span class="props-note">{pathOf(item.id)}</span><span class="props-note"
              >{t(item.matched_in === 'title' ? 'wikiSearchTitleHit' : 'wikiSearchBodyHit')}</span
            ></a
          >
        </li>
      {/each}
    </ul>
  </nav>
{/if}
