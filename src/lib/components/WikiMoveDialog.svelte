<script lang="ts">
  import { tick } from 'svelte';
  import type { WikiNode } from '../../shared/operations/wiki/index.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { wikiMoveOptions } from '../wiki-move.ts';
  import { showToast } from '../toast.svelte.ts';
  import Dialog from './Dialog.svelte';
  let { pages, onmove }: { pages: readonly WikiNode[]; onmove: (item: WikiNode, parent: string | null) => void } =
    $props();
  let dialog = $state<ReturnType<typeof Dialog>>();
  let open = $state(false);
  let item = $state<WikiNode | null>(null);
  let choice = $state('');
  let heading = $state('');
  const id = $props.id();
  const options = $derived(wikiMoveOptions(pages, item?.id ?? ''));
  const unavailable = $derived(options.filter((option) => option.disabled).length);
  export function show(trigger: HTMLElement, target: WikiNode) {
    item = target;
    heading = target.title;
    choice = target.parent_id ?? '';
    dialog?.show(trigger);
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!item) return;
    const moving = item;
    item = null;
    open = false;
    await tick();
    if ((choice || null) !== moving.parent_id) onmove(moving, choice || null);
    else showToast(t('wikiMoveUnchanged'));
  }
</script>

<Dialog bind:this={dialog} bind:open title={t('moveParentTitle', { title: heading })}>
  <form id={`${id}-form`} class="form" onsubmit={submit}>
    <div class="field">
      <label for={id}>{t('moveParentField')}</label>
      <select {id} class="select" bind:value={choice} aria-describedby={`${id}-hint`}>
        <option value="">{t('wikiMoveRoot')}</option>
        {#each options as parent (parent.id)}<option value={parent.id} disabled={parent.disabled}
            >{'　'.repeat(parent.depth - 1)}{parent.title}{parent.disabled ? t('wikiMoveUnavailable') : ''}</option
          >{/each}
      </select>
      <p class="field-hint" id={`${id}-hint`}>
        {t('wikiMoveHint')}
        {t('wikiMoveUnavailableCount', { count: unavailable })}
      </p>
    </div>
  </form>
  {#snippet footer(close)}
    <button type="button" class="btn" onclick={close}>{t('cancel')}</button>
    <button type="submit" class="btn is-primary" form={`${id}-form`}>{t('moveParentSubmit')}</button>
  {/snippet}
</Dialog>
