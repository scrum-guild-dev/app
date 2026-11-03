<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import type { ApiResult } from '../api.ts';
  import type { WikiClient } from '../wiki-client.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type { InputOf, OutputOf } from '../../shared/operations/define.ts';
  import {
    type workspaceWikiRevisions,
    type workspaceWikiUpdate,
    type WikiPage,
  } from '../../shared/operations/wiki/index.ts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import WikiContent from './WikiContent.svelte';

  let {
    wiki,
    current,
    canWrite,
    update,
    onclose,
    onrestored,
    onbusy,
    internalLinkPrefix,
  }: {
    wiki: WikiClient;
    current: WikiPage;
    canWrite: boolean;
    onbusy: (busy: boolean) => void;
    internalLinkPrefix: string;
    update: (
      input: Omit<InputOf<typeof workspaceWikiUpdate>, 'workspace_id'>,
    ) => Promise<ApiResult<{ page: WikiPage }>>;
    onclose: () => void;
    onrestored: (page: WikiPage) => Promise<void>;
  } = $props();
  let revisions = $state<OutputOf<typeof workspaceWikiRevisions>['revisions']>([]);
  let selected = $state<WikiPage | null>(null);
  let loading = $state(false);
  let failure = $state('');
  let conflicted = $state(false);
  let saving = $state(false);
  let confirming = $state(false);
  let request = 0;
  let active = true;
  let dialog = $state<ReturnType<typeof ConfirmDialog>>();
  const listedVersion = $derived(revisions[0]?.version ?? current.version);
  const stale = $derived(conflicted || listedVersion !== current.version);
  const metadata = $derived(revisions.find((revision) => revision.version === selected?.version));
  const busy = $derived(saving || confirming);
  $effect(() => {
    onbusy(busy);
  });
  beforeNavigate((navigation) => {
    if (busy) navigation.cancel();
  });
  onMount(() => {
    void load();
    return () => {
      active = false;
      onbusy(false);
      request++;
    };
  });

  async function load() {
    if (busy || conflicted) return;
    const generation = ++request;
    selected = null;
    loading = true;
    failure = '';
    const result = await wiki.readRevisions(current.id);
    if (!active || generation !== request) return;
    loading = false;
    if (result.ok) {
      revisions = result.data.revisions;
      await tick();
      document.getElementById('wiki-history-title')?.focus();
    } else failure = t('wikiHistoryFailed');
  }
  async function open(version: number) {
    if (busy || conflicted) return;
    const generation = ++request;
    selected = null;
    loading = true;
    failure = '';
    const result = await wiki.readPage(current.id, version);
    if (!active || generation !== request) return;
    loading = false;
    if (result.ok) {
      selected = result.data.page;
      await tick();
      document.getElementById('wiki-history-title')?.focus();
    } else failure = t('wikiRevisionFailed');
  }
  async function restore(trigger: HTMLElement) {
    if (busy || stale || !canWrite || !selected || selected.version === listedVersion) return;
    const historical = selected;
    const readVersion = current.version;
    confirming = true;
    const confirmed = await dialog?.ask(trigger);
    confirming = false;
    if (!confirmed || !active) return;
    saving = true;
    failure = '';
    try {
      const result = await update({
        page_id: current.id,
        read_version: readVersion,
        title: historical.title,
        body_md: historical.body_md,
      });
      if (!active) return;
      if (result.ok) await onrestored(result.data.page);
      else {
        conflicted = result.error?.code === 'conflict';
        failure = t(
          result.error?.code === 'conflict'
            ? 'wikiRestoreConflict'
            : result.status === 404
              ? 'wikiHistoryGone'
              : result.error?.code === 'workspace_closed'
                ? 'wikiClosed'
                : result.error?.code === 'rate_limited'
                  ? 'wikiRateLimited'
                  : result.error?.code === 'attachment_quota_exceeded'
                    ? 'wikiRestoreQuota'
                    : 'wikiRestoreFailed',
        );
      }
    } finally {
      saving = false;
    }
  }
</script>

<div class="wiki-head">
  <h2 id="wiki-history-title" class="section-title wrap-anywhere" tabindex="-1">
    {selected?.title ?? t('wikiHistory')}
  </h2>
  <div class="form-actions">
    <button
      class="btn"
      type="button"
      aria-disabled={busy}
      onclick={() => {
        if (!busy) onclose();
      }}>{t('wikiBackToPage')}</button
    >
  </div>
</div>
<p class="field-hint">{t('wikiHistoryHint')}</p>
<p role="status">{loading ? t('wikiHistoryLoading') : saving ? t('wikiSaving') : ''}</p>
{#if failure}<p class="callout is-warn" role="alert">{failure}</p>
  {#if !conflicted}<button class="btn" type="button" aria-disabled={busy} onclick={load}>{t('wikiHistoryRetry')}</button
    >{/if}
{/if}
{#if stale && !failure}<p class="callout is-warn">{t('wikiHistoryChanged')}</p>{/if}
{#if selected}
  <div class="callout is-info">
    <p>{t('wikiViewingRevision', { version: selected.version, current: listedVersion })}</p>
    {#if metadata}<p class="wrap-anywhere">
        {metadata.saved_by_name} · <time datetime={metadata.saved_at}>{formatDateTime(metadata.saved_at)}</time>
      </p>{/if}
    <div class="form-actions">
      {#if canWrite && !stale && selected.version !== listedVersion}<button
          class="btn is-primary"
          type="button"
          aria-disabled={busy}
          onclick={(event) => restore(event.currentTarget)}>{t('wikiRestore')}</button
        >{/if}
      {#if !conflicted}<button class="btn" type="button" aria-disabled={busy} onclick={load}
          >{t('wikiBackToHistory')}</button
        >{/if}
    </div>
  </div>
  <WikiContent source={selected.body_md} {internalLinkPrefix} />
{:else if !loading && !failure}
  <div class="table-wrap">
    <table class="table is-stacked">
      <thead
        ><tr
          ><th scope="col">{t('wikiRevision')}</th><th scope="col">{t('wikiTitle')}</th><th scope="col"
            >{t('wikiSavedBy')}</th
          ><th scope="col">{t('wikiSavedAt')}</th><th scope="col" class="is-actions"
            ><span class="visually-hidden">{t('wikiActions')}</span></th
          ></tr
        ></thead
      >
      <tbody
        >{#each revisions as revision (revision.version)}<tr>
            <td data-label={t('wikiRevision')}
              >{t('wikiRevisionNumber', { version: revision.version })}{#if revision.version === listedVersion}
                <span class="chip is-ok">{t('wikiCurrentRevision')}</span>{/if}</td
            >
            <td class="is-wrap wrap-anywhere" data-label={t('wikiTitle')}>{revision.title}</td>
            <td class="is-wrap wrap-anywhere" data-label={t('wikiSavedBy')}>{revision.saved_by_name}</td>
            <td data-label={t('wikiSavedAt')}
              ><time datetime={revision.saved_at}>{formatDateTime(revision.saved_at)}</time></td
            >
            <td class="is-actions"
              ><button
                class="btn is-sm"
                type="button"
                aria-label={t(revision.version === listedVersion ? 'wikiOpenRevisionLabel' : 'wikiViewRevision', {
                  version: revision.version,
                })}
                onclick={() => open(revision.version)}
                >{t(revision.version === listedVersion ? 'wikiOpenRevision' : 'wikiViewPast')}</button
              ></td
            >
          </tr>{/each}</tbody
      >
    </table>
  </div>
  <p class="field-hint">{t('wikiHistoryRestoreHint')}</p>
{/if}
<ConfirmDialog
  bind:this={dialog}
  title={t('wikiRestoreTitle')}
  confirmLabel={t('wikiRestoreConfirm')}
  cancelLabel={t('cancel')}
>
  <p>{t('wikiRestoreText', { version: selected?.version ?? '', next: listedVersion + 1 })}</p>
</ConfirmDialog>
