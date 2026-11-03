<script lang="ts">
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import { untrack, tick } from 'svelte';
  import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
  import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
  import { callOperation } from '../api.ts';
  import { invalidate } from '$app/navigation';
  import { orgWikiMove, workspaceWikiMove, type WikiNode } from '../../shared/operations/wiki/index.ts';
  import Icon from './Icon.svelte';
  import { wikiAncestorIds } from '../wiki-move.ts';
  import { showToast } from '../toast.svelte.ts';
  import WikiMoveDialog from './WikiMoveDialog.svelte';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { workspaceWikiTree } from '../../shared/operations/wiki/index.ts';

  let {
    pages,
    slug,
    workspaceId,
    currentId,
    canWrite = false,
  }: {
    pages: OutputOf<typeof workspaceWikiTree>['pages'];
    slug: string;
    workspaceId: string | null;
    currentId: string | null;
    canWrite?: boolean;
  } = $props();
  let ordering = $state(false);
  let busy = $state(false);
  let feedback = $state('');
  let failed = $state(false);
  let dragged = $state<string | null>(null);
  let dropId = $state<string | null>(null);
  let dropPart = $state<'before' | 'child' | 'after'>('child');
  let moveDialog = $state<ReturnType<typeof WikiMoveDialog>>();
  const treeId = $props.id();
  async function move(item: WikiNode, parentId: string | null, afterId?: string | null, focusId?: string) {
    if (busy || !canWrite) return;
    busy = true;
    feedback = '';
    failed = false;
    const focused = document.activeElement;
    const scopeKey = `${slug}/${workspaceId ?? ''}`;
    try {
      const input = {
        page_id: item.id,
        parent_id: parentId,
        ...(afterId !== undefined ? { after_page_id: afterId } : {}),
      };
      const result =
        workspaceId === null
          ? await callOperation(orgWikiMove, input, { slug })
          : await callOperation(workspaceWikiMove, { workspace_id: workspaceId, ...input }, { slug });
      if (scopeKey !== `${slug}/${workspaceId ?? ''}`) return;
      failed = !result.ok;
      const details = result.ok ? undefined : result.error?.details;
      const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
      feedback = t(
        result.ok
          ? 'wikiMoved'
          : reason === 'cycle'
            ? 'wikiMoveCycle'
            : reason === 'too_deep'
              ? 'wikiMoveDepth'
              : !result.ok && result.error?.code === 'workspace_closed'
                ? 'wikiClosed'
                : 'wikiMoveFailed',
      );
      if (result.ok) {
        for (const id of wikiAncestorIds(pages, parentId)) expanded.add(id);
        showToast(feedback);
      }
      await invalidate('app:wiki');
      await tick();
      if (
        canWrite &&
        (document.activeElement === focused ||
          (focused instanceof HTMLElement && !focused.isConnected && document.activeElement === document.body))
      )
        document.getElementById(focusId ?? `${treeId}-${item.id}`)?.focus();
    } finally {
      busy = false;
    }
  }
  function reorder(item: WikiNode, direction: -1 | 1) {
    const siblings = childrenByParent.get(item.parent_id) ?? [];
    const index = siblings.findIndex((row) => row.id === item.id);
    const after = direction === -1 ? (siblings[index - 2]?.id ?? null) : siblings[index + 1]?.id;
    if (after === undefined || (direction === -1 && index === 0) || (direction === 1 && index === siblings.length - 1))
      return;
    void move(item, item.parent_id, after, `${treeId}-${item.id}-${direction === -1 ? 'up' : 'down'}`);
  }
  function dnd(element: HTMLElement, item: WikiNode) {
    let current = item;
    const cleanup = combine(
      draggable({
        element,
        dragHandle: element.querySelector<HTMLElement>('[data-wiki-handle]') ?? undefined,
        canDrag: () => canWrite && ordering && !busy,
        getInitialData: () => ({ wikiTree: treeId, id: current.id }),
        onDragStart: () => {
          dragged = current.id;
        },
        onDrop: () => {
          dragged = null;
          dropId = null;
        },
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) =>
          canWrite && ordering && !busy && source.data.wikiTree === treeId && source.data.id !== current.id,
        onDrag: ({ location }) => {
          const rect = element.getBoundingClientRect();
          const fraction = (location.current.input.clientY - rect.top) / rect.height;
          dropId = current.id;
          dropPart = fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'child';
        },
        onDragLeave: () => {
          if (dropId === current.id) dropId = null;
        },
        onDrop: ({ source, location }) => {
          const moving = pages.find((row) => row.id === source.data.id);
          if (!moving || source.data.wikiTree !== treeId) return;
          const rect = element.getBoundingClientRect();
          const fraction = (location.current.input.clientY - rect.top) / rect.height;
          if (fraction >= 0.25 && fraction <= 0.75) void move(moving, current.id);
          else {
            const siblings = (childrenByParent.get(current.parent_id) ?? []).filter((row) => row.id !== moving.id);
            const index = siblings.findIndex((row) => row.id === current.id);
            void move(moving, current.parent_id, fraction < 0.25 ? (siblings[index - 1]?.id ?? null) : current.id);
          }
        },
      }),
    );
    return {
      update(value: WikiNode) {
        current = value;
      },
      destroy: cleanup,
    };
  }
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
      <div
        class="wiki-node"
        use:dnd={item}
        class:is-dragging={dragged === item.id}
        data-drop={dropId === item.id ? dropPart : undefined}
      >
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
          id={`${treeId}-${item.id}`}
          class="wiki-link"
          href={workspaceId === null
            ? resolve('/[slug]/wiki/[pageId]', { slug, pageId: item.id })
            : resolve('/[slug]/w/[id]/wiki/[pageId]', { slug, id: workspaceId, pageId: item.id })}
          aria-current={currentId === item.id ? 'page' : undefined}>{item.title}</a
        >
        <button
          hidden={!canWrite || !ordering}
          class="icon-btn"
          type="button"
          data-wiki-handle
          aria-label={t('wikiDrag', { title: item.title })}
          disabled={busy}
          title={t('wikiDragHint')}><Icon name="grip" /></button
        >
      </div>
      {#if canWrite && ordering}
        {@const siblings = childrenByParent.get(item.parent_id) ?? []}
        <div class="form-actions">
          <button
            class="btn is-quiet"
            type="button"
            id={`${treeId}-${item.id}-up`}
            aria-disabled={busy || siblings[0]?.id === item.id}
            aria-label={t('moveUpLabel', { title: item.title })}
            onclick={() => reorder(item, -1)}>{t('moveUp')}</button
          >
          <button
            class="btn is-quiet"
            type="button"
            id={`${treeId}-${item.id}-down`}
            aria-disabled={busy || siblings.at(-1)?.id === item.id}
            aria-label={t('moveDownLabel', { title: item.title })}
            onclick={() => reorder(item, 1)}>{t('moveDown')}</button
          >
          <button
            class="btn is-quiet"
            type="button"
            aria-disabled={busy}
            id={`${treeId}-${item.id}-parent`}
            aria-label={t('moveParentLabel', { title: item.title })}
            onclick={(event) => {
              if (!busy) moveDialog?.show(event.currentTarget, item);
            }}>{t('moveParent')}</button
          >
        </div>
      {/if}
      {#if children}<ul id={`wiki-branch-${item.id}`} hidden={!expanded.has(item.id)}>
          {#if expanded.has(item.id)}{@render branch(item.id, depth + 1)}{/if}
        </ul>{/if}
    </li>
  {/each}
{/snippet}

{#if canWrite}<button
    class="btn"
    type="button"
    disabled={busy}
    aria-pressed={ordering}
    onclick={() => {
      ordering = !ordering;
    }}>{t('wikiReorder')}</button
  >{/if}
<nav aria-label={t(workspaceId === null ? 'orgWikiTreeLabel' : 'wikiTreeLabel')}>
  <ul class="wiki-tree panel">{@render branch(null, 1)}</ul>
</nav>

<p role={failed ? 'alert' : 'status'} class="field-hint">{feedback}</p>
{#if dropId}<p class="field-hint" role="status">
    {t(dropPart === 'child' ? 'wikiDropChild' : dropPart === 'before' ? 'wikiDropBefore' : 'wikiDropAfter', {
      title: pages.find((item) => item.id === dropId)?.title ?? '',
    })}
  </p>{/if}
<WikiMoveDialog
  bind:this={moveDialog}
  {pages}
  onmove={(item, parentId) => void move(item, parentId, undefined, `${treeId}-${item.id}-parent`)}
/>
