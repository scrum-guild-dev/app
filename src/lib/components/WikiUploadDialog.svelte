<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { WikiNode } from '../../shared/operations/wiki/index.ts';
  import { WIKI_UPLOAD_MAX_FILES, wikiUploadTitle } from '../../shared/wiki-transfer.ts';
  import { parseWikiFrontmatter } from '../../shared/wiki.ts';
  import { readWikiFile, type SelectedWikiFile } from '../wiki-files.ts';
  import type { WikiClient } from '../wiki-client.ts';
  import { wikiMoveOptions } from '../wiki-move.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let {
    wiki,
    pages,
    busy = $bindable(false),
    onuploaded,
    onrefresh,
  }: {
    wiki: WikiClient;
    pages: readonly WikiNode[];
    busy?: boolean;
    onuploaded: (count: number) => Promise<void>;
    onrefresh: () => Promise<boolean>;
  } = $props();
  let dialog = $state<ReturnType<typeof Dialog>>();
  let open = $state(false);
  let files = $state<SelectedWikiFile[]>([]);
  let parent = $state('');
  let reading = $state(false);
  let over = $state(false);
  let failure = $state('');
  let parentError = $state('');
  let uncertain = $state(false);
  let refreshed = $state(false);
  let acknowledged = $state(false);
  let beforeIds = $state<string[]>([]);
  const addedPages = $derived(refreshed ? pages.filter((page) => !beforeIds.includes(page.id)) : []);
  let picker: HTMLInputElement;
  let chooseButton = $state<HTMLButtonElement>();
  let generation = 0;
  const id = $props.id();
  const parents = $derived(wikiMoveOptions(pages, ''));
  const unavailable = $derived(parents.filter((item) => item.disabled).length);
  const allowed = $derived(
    files.length > 0 &&
      files.length <= WIKI_UPLOAD_MAX_FILES &&
      files.every((file) => file.problem === null) &&
      !reading &&
      !busy &&
      (!uncertain || (refreshed && acknowledged)) &&
      (parent === '' || parents.some((item) => item.id === parent && !item.disabled)),
  );
  $effect(() => {
    if (!open) {
      generation++;
      files = [];
      failure = '';
      parentError = '';
      over = false;
      uncertain = false;
      refreshed = false;
      acknowledged = false;
    }
  });
  export function show(trigger: HTMLElement, parentId: string | null) {
    if (busy) return;
    parent = parents.some((item) => item.id === parentId && !item.disabled) ? parentId! : '';
    dialog?.show(trigger);
  }
  async function add(selected: FileList | File[]) {
    if (busy || reading) return;
    failure = '';
    const seen = new SvelteSet(files.map((file) => file.key));
    const fresh = Array.from(selected).filter((file) => {
      const key = JSON.stringify([file.name, file.size, file.lastModified]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length + files.length > WIKI_UPLOAD_MAX_FILES) {
      failure = t('wikiUploadCountError');
      return;
    }
    reading = true;
    const request = generation;
    try {
      const loaded = await Promise.all(fresh.map(readWikiFile));
      if (open && request === generation) files = [...files, ...loaded];
    } finally {
      reading = false;
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!allowed) return;
    busy = true;
    failure = '';
    parentError = '';
    beforeIds = pages.map((page) => page.id);
    uncertain = false;
    refreshed = false;
    acknowledged = false;
    try {
      const result = await wiki.upload(
        files.map(({ file_name, body_md }) => ({ file_name, body_md })),
        parent || null,
      );
      if (result.ok) {
        const count = result.data.pages.length;
        files = [];
        open = false;
        await onuploaded(count);
      } else {
        const code = result.error?.code;
        uncertain = result.status === 0 || result.status >= 500 || result.status < 400;
        const details = result.error?.details;
        if (code === 'invalid_input' && Array.isArray(details)) {
          files = files.map((file, index) => {
            const detail = details.find(
              (item) =>
                item &&
                typeof item === 'object' &&
                'path' in item &&
                typeof item.path === 'string' &&
                item.path.startsWith(`files.${index}.`),
            );
            const reason = detail && typeof detail === 'object' && 'message' in detail ? detail.message : null;
            const known = ['extension', 'file_name', 'too_long', 'invalid_character', 'title'] as const;
            const problem = known.find((value) => value === reason);
            return problem ? { ...file, problem } : file;
          });
        }
        failure = t(
          code === 'workspace_closed'
            ? 'wikiClosed'
            : code === 'attachment_quota_exceeded'
              ? 'wikiUploadQuota'
              : code === 'rate_limited'
                ? 'wikiUploadRate'
                : result.status === 404
                  ? 'wikiUploadGone'
                  : code === 'conflict'
                    ? 'wikiDepth'
                    : code === 'invalid_input'
                      ? 'wikiUploadInvalid'
                      : 'wikiUploadFailed',
        );
        if (code === 'conflict') parentError = t('wikiDepth');
        await tick();
        document.getElementById(`${id}-failure`)?.focus();
      }
    } finally {
      busy = false;
    }
  }
  async function removeFile(key: string) {
    if (busy || reading) return;
    files = files.filter((item) => item.key !== key);
    await tick();
    chooseButton?.focus();
  }
  async function refreshResult() {
    if (busy) return;
    busy = true;
    try {
      refreshed = await onrefresh();
      acknowledged = false;
      if (!refreshed) failure = t('wikiUploadRefreshFailed');
    } finally {
      busy = false;
    }
  }
  function problem(file: SelectedWikiFile) {
    switch (file.problem) {
      case 'extension':
        return t('wikiUploadExtension');
      case 'file_name':
        return t('wikiUploadFileName');
      case 'too_long':
        return t('wikiUploadTooLong');
      case 'invalid_character':
        return t('wikiBodyInvalid');
      case 'title':
        return t('wikiUploadTitleInvalid');
      case 'utf8':
        return t('wikiUploadUtf8');
      case 'read':
        return t('wikiUploadRead');
      default:
        return '';
    }
  }
</script>

<Dialog bind:this={dialog} bind:open dismissible={!busy} title={t('wikiUpload')}>
  <form {id} class="form" onsubmit={submit}>
    <div class="field">
      <label for={`${id}-parent`}>{t('wikiUploadParent')}</label>
      <select
        id={`${id}-parent`}
        class="select"
        bind:value={parent}
        disabled={busy}
        aria-describedby={`${id}-parent-hint${parentError ? ` ${id}-parent-error` : ''}`}
        aria-invalid={parentError ? true : undefined}
        onchange={() => {
          parentError = '';
          failure = '';
        }}
      >
        <option value="">{t('wikiMoveRoot')}</option>
        {#each parents as item (item.id)}
          <option value={item.id} disabled={item.disabled}
            >{'　'.repeat(item.depth - 1)}{item.title}{item.disabled ? t('wikiMoveUnavailable') : ''}</option
          >
        {/each}
      </select>
      <p class="field-hint" id={`${id}-parent-hint`}>
        {t('wikiUploadParentHint')}
        {t('wikiMoveUnavailableCount', { count: unavailable })}
      </p>
      {#if parentError}<p class="field-error" id={`${id}-parent-error`}>{parentError}</p>{/if}
    </div>
    <div
      class="dropzone"
      class:is-over={over}
      class:is-disabled={busy || reading}
      role="group"
      aria-label={t('wikiUpload')}
      ondragover={(event) => {
        event.preventDefault();
        if (!busy && !reading) over = true;
      }}
      ondragleave={() => (over = false)}
      ondrop={(event) => {
        event.preventDefault();
        over = false;
        if (event.dataTransfer) void add(event.dataTransfer.files);
      }}
    >
      <Icon name="upload" />
      <span class="dropzone-text"><b>{t('wikiUploadDrop')}</b><span>{t('wikiUploadHint')}</span></span>
      <input
        bind:this={picker}
        type="file"
        accept=".md"
        multiple
        hidden
        onchange={(event) => {
          if (event.currentTarget.files) void add(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
      />
      <button
        bind:this={chooseButton}
        type="button"
        class="btn is-sm"
        aria-disabled={busy || reading}
        onclick={() => {
          if (!busy && !reading) picker.click();
        }}>{t('wikiUploadChoose')}</button
      >
    </div>
    {#each files as file (file.key)}
      <div class="file-row" class:is-error={file.problem !== null}>
        <Icon name={file.problem ? 'alert' : 'file'} />
        <div class="file-main">
          <span class="file-name">{file.file_name}</span>
          {#if file.contentRead}<span class="file-meta"
              >{t('wikiUploadTitle', { title: wikiUploadTitle(file) ?? '—' })}
              {t(parseWikiFrontmatter(file.body_md).title ? 'wikiUploadFromTitle' : 'wikiUploadFromName')}・{t(
                'wikiUploadLength',
                { count: [...file.body_md].length },
              )}</span
            >{:else}<span class="file-meta">{t('wikiUploadUnread')}</span>{/if}
          {#if file.problem}<span class="file-meta">{problem(file)}</span>{/if}
        </div>
        <div class="file-actions">
          <button
            type="button"
            class="btn is-sm is-quiet"
            aria-label={t('wikiUploadRemoveLabel', { name: file.file_name })}
            aria-disabled={busy || reading}
            onclick={() => removeFile(file.key)}>{t('wikiUploadRemove')}</button
          >
        </div>
      </div>
    {/each}
    <p class="field-hint" role="status">
      {busy ? t('wikiUploadSaving') : reading ? t('wikiUploadReading') : t('wikiUploadCount', { count: files.length })}
    </p>
    {#if files.some((file) => file.problem)}<p class="field-hint">{t('wikiUploadFix')}</p>{/if}
    {#if failure}<p class="callout is-warn" role="alert" id={`${id}-failure`} tabindex="-1">{failure}</p>{/if}
    {#if uncertain}
      <section class="callout is-warn">
        <p>{t('wikiUploadUncertain')}</p>
        <button type="button" class="btn" aria-disabled={busy} onclick={refreshResult}>{t('wikiUploadRefresh')}</button>
        {#if refreshed}
          <p>{t('wikiUploadNewPages', { count: addedPages.length })}</p>
          {#if addedPages.length}<ul>
              {#each addedPages as item (item.id)}<li class="wrap-anywhere">{item.title}</li>{/each}
            </ul>{/if}
          <label
            ><input type="checkbox" bind:checked={acknowledged} disabled={busy} />{t('wikiUploadAcknowledge')}</label
          >
        {/if}
      </section>
    {/if}
  </form>
  {#snippet footer(close)}
    <button type="button" class="btn" aria-disabled={busy} onclick={close}>{t('cancel')}</button>
    <button type="submit" form={id} class="btn is-primary" aria-disabled={!allowed}
      >{busy ? t('wikiUploadSaving') : t('wikiUploadSubmit', { count: files.length })}</button
    >
  {/snippet}
</Dialog>
