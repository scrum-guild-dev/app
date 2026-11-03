<script lang="ts">
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import { untrack } from 'svelte';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { workspaceWikiTree } from '../../shared/operations/wiki/index.ts';

  let {
    pages,
    slug,
    workspaceId,
    currentId,
  }: {
    pages: OutputOf<typeof workspaceWikiTree>['pages'];
    slug: string;
    workspaceId: string | null;
    currentId: string | null;
  } = $props();
  const expanded = new SvelteSet<string>();
  const childrenByParent = $derived.by(() => {
    const grouped = new SvelteMap<string | null, typeof pages>();
    for (const item of pages) {
      const siblings = grouped.get(item.parent_id);
      if (siblings) siblings.push(item);
      else grouped.set(item.parent_id, [item]);
    }
    return grouped;
  });
  $effect(() => {
    let parent = pages.find((item) => item.id === currentId)?.parent_id;
    const ancestors: string[] = [];
    while (parent && !ancestors.includes(parent)) {
      ancestors.push(parent);
      parent = pages.find((item) => item.id === parent)?.parent_id;
    }
    untrack(() => {
      for (const id of ancestors) expanded.add(id);
    });
  });
  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }
</script>

{#snippet branch(parentId: string | null, depth: number)}
  {#each childrenByParent.get(parentId) ?? [] as item (item.id)}
    {@const children = depth < 10 && (childrenByParent.get(item.id)?.length ?? 0) > 0}
    <li>
      <div class="wiki-node">
        {#if children}
          <button
            class="tree-caret"
            type="button"
            aria-label={t(expanded.has(item.id) ? 'wikiCollapse' : 'wikiExpand', { title: item.title })}
            aria-expanded={expanded.has(item.id)}
            aria-controls={`wiki-branch-${item.id}`}
            onclick={() => toggle(item.id)}>{expanded.has(item.id) ? '▾' : '▸'}</button
          >
        {:else}<span class="wiki-slot"></span>{/if}
        <a
          class="wiki-link"
          href={workspaceId === null
            ? resolve('/[slug]/wiki/[pageId]', { slug, pageId: item.id })
            : resolve('/[slug]/w/[id]/wiki/[pageId]', { slug, id: workspaceId, pageId: item.id })}
          aria-current={currentId === item.id ? 'page' : undefined}>{item.title}</a
        >
      </div>
      {#if children}<ul id={`wiki-branch-${item.id}`} hidden={!expanded.has(item.id)}>
          {#if expanded.has(item.id)}{@render branch(item.id, depth + 1)}{/if}
        </ul>{/if}
    </li>
  {/each}
{/snippet}

<nav aria-label={t(workspaceId === null ? 'orgWikiTreeLabel' : 'wikiTreeLabel')}>
  <ul class="wiki-tree panel">{@render branch(null, 1)}</ul>
</nav>
