<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { attachmentDelete, attachmentDownload, attachmentList } from '../../shared/operations/attachment/index.ts';
  import { operationPath, type OutputOf } from '../../shared/operations/define.ts';
  import { callOperation } from '../api.ts';
  import { attachmentMedia, attachmentSize } from '../attachment-display.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import AttachmentImage from './AttachmentImage.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let {
    slug,
    workspaceId,
    taskId,
    canWrite,
    revision,
    ondeleted,
    onstale,
  }: {
    slug: string;
    workspaceId: string;
    taskId: string;
    canWrite: boolean;
    revision: number;
    ondeleted: (id: string) => void;
    onstale: () => void;
  } = $props();
  type File = OutputOf<typeof attachmentList>['attachments'][number];
  let files = $state<File[]>([]);
  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let nextCursor = $state<OutputOf<typeof attachmentList>['next_cursor']>();
  let loadingMore = $state(false);
  let moreFailed = $state(false);
  let deleting = $state(false);
  let deleteFileName = $state('');
  let previewOpen = $state(false);
  let selected = $state<File | null>(null);
  let previewFailed = $state(false);
  let preview = $state<ReturnType<typeof Dialog>>();
  let confirm = $state<ReturnType<typeof ConfirmDialog>>();
  // 閉じた動画の再生・通信を止めるため、プレビューの中身も外す。
  $effect(() => {
    if (!previewOpen) selected = null;
  });
  let heading = $state<HTMLHeadingElement>();
  let request = 0;
  async function restoreFocus(): Promise<void> {
    await tick();
    if (document.activeElement === document.body) heading?.focus();
  }
  async function retry(): Promise<void> {
    loadState = 'loading';
    await tick();
    await restoreFocus();
    await load();
  }
  const headingId = $props.id();
  function url(file: File): string {
    return operationPath(attachmentDownload, slug, { id: file.id });
  }
  async function load(append = false): Promise<void> {
    const after = append ? nextCursor : undefined;
    if (append && (after === undefined || loadingMore || deleting)) return;
    const current = ++request;
    loadingMore = append;
    moreFailed = false;
    const result = await callOperation(
      attachmentList,
      {
        workspace_id: workspaceId,
        task_id: taskId,
        ...(after === undefined ? {} : { after }),
      },
      { slug },
    );
    if (current !== request) return;
    loadingMore = false;
    if (result.ok) {
      if (append) {
        const seen = new Set(files.map((file) => file.id));
        files = [...files, ...result.data.attachments.filter((file) => !seen.has(file.id))];
      } else files = result.data.attachments;
      nextCursor = result.data.next_cursor;
      loadState = 'ready';
      if (append && nextCursor === undefined) void restoreFocus();
    } else if (append) moreFailed = true;
    else loadState = 'failed';
  }
  $effect(() => {
    const dependencies = [revision, slug, workspaceId, taskId];
    void dependencies;
    untrack(() => {
      loadState = 'loading';
      loadingMore = false;
      moreFailed = false;
      nextCursor = undefined;
      void load();
    });
    return () => {
      request++;
    };
  });
  function open(file: File, trigger: HTMLElement): void {
    selected = file;
    previewFailed = false;
    preview?.show(trigger);
  }
  async function remove(file: File, trigger: HTMLElement): Promise<void> {
    if (deleting || !canWrite || !file.deletable) return;
    deleteFileName = file.file_name;
    if (!(await confirm?.ask(trigger))) return;
    deleting = true;
    const result = await callOperation(
      attachmentDelete,
      {
        workspace_id: workspaceId,
        task_id: taskId,
        attachment_id: file.id,
      },
      { slug },
    );
    deleting = false;
    if (result.ok) {
      request++;
      loadingMore = false;
      moreFailed = false;
      loadState = 'ready';
      files = files.filter((row) => row.id !== file.id);
      if (selected?.id === file.id) {
        previewOpen = false;
        selected = null;
      }
      showToast(t('attachmentDeleted'), 'check');
      ondeleted(file.id);
      void restoreFocus();
    } else {
      showToast(t('attachmentDeleteFailed'), 'alert');
      if (result.error?.code === 'workspace_closed') onstale();
      void load();
    }
  }
</script>

<section class="field" aria-labelledby={headingId}>
  <h3 bind:this={heading} tabindex="-1" class="field-label" id={headingId}>{t('attachmentListTitle')}</h3>
  {#if loadState === 'loading'}
    <p role="status">{t('retrying')}</p>
  {:else if loadState === 'failed'}
    <p role="alert">{t('attachmentListFailed')}</p>
    <button class="btn is-sm" type="button" onclick={() => void retry()}>{t('retry')}</button>
  {:else}
    <div class="files">
      {#if files.length === 0 && !canWrite}<p role="status">{t('attachmentNone')}</p>{/if}
      {#each files as file (file.id)}
        <div class="file-row">
          <Icon
            name={attachmentMedia(file.content_type) === 'image'
              ? 'image'
              : attachmentMedia(file.content_type) === 'video'
                ? 'play'
                : 'file'}
          />
          <div class="file-main">
            {#if attachmentMedia(file.content_type) !== null}
              <button class="file-name" type="button" onclick={(event) => open(file, event.currentTarget)}
                >{file.file_name}</button
              >
            {:else}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve 添付の配信 URL は API の定義から作る -->
              <a class="file-name" href={url(file)} download={file.file_name}>{file.file_name}</a>
            {/if}
            <span class="file-meta"
              ><span class="mono">{attachmentSize(file.size_bytes)}</span>・{file.uploaded_by_name ??
                t('attachmentUploaderUnknown')}・<time class="mono" datetime={file.created_at}
                >{formatDateTime(file.created_at)}</time
              ></span
            >
          </div>
          <div class="file-actions">
            <!-- eslint-disable svelte/no-navigation-without-resolve 添付の配信 URL -->
            <a
              class="icon-btn"
              href={url(file)}
              download={file.file_name}
              aria-label={t('attachmentDownloadLabel', { name: file.file_name })}><Icon name="download" /></a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {#if canWrite && file.deletable}
              <button
                class="icon-btn is-danger"
                type="button"
                disabled={deleting}
                aria-label={t('attachmentDeleteLabel', { name: file.file_name })}
                onclick={(event) => void remove(file, event.currentTarget)}><Icon name="trash" /></button
              >
            {/if}
          </div>
        </div>
      {/each}
      {#if nextCursor !== undefined}
        {#if moreFailed}<p role="alert">{t('attachmentMoreFailed')}</p>{/if}
        <button class="btn is-sm" type="button" disabled={loadingMore || deleting} onclick={() => void load(true)}
          >{loadingMore ? t('retrying') : moreFailed ? t('retry') : t('attachmentLoadMore')}</button
        >
      {/if}
      {#if canWrite}
        <div class="dropzone is-disabled">
          <Icon name="upload" />
          <span class="dropzone-text"
            ><b>{t('attachmentUploadPlace')}</b><span id={`${headingId}-add`}>{t('attachmentAddViaBody')}</span></span
          >
          <button class="btn is-sm" type="button" disabled aria-describedby={`${headingId}-add`}
            >{t('attachmentChoose')}</button
          >
        </div>
      {/if}
    </div>
  {/if}
</section>

<Dialog bind:open={previewOpen} bind:this={preview} title={selected?.file_name ?? t('attachmentListTitle')}>
  {#if selected !== null}
    <div class="preview">
      {#if attachmentMedia(selected.content_type) === 'image'}
        <AttachmentImage src={url(selected)} alt={selected.file_name} />
      {:else if previewFailed}
        <p role="status">{t('attachmentImageMissing')}</p>
      {:else}
        <!-- eslint-disable-next-line svelte/no-unused-svelte-ignore -->
        <!-- svelte-ignore a11y_media_has_caption (添付動画の字幕は別途提供されていない) -->
        <video src={url(selected)} controls onerror={() => (previewFailed = true)}></video>
      {/if}
    </div>
    <p class="file-meta">
      {attachmentSize(selected.size_bytes)}・{selected.uploaded_by_name ??
        t('attachmentUploaderUnknown')}・{formatDateTime(selected.created_at)}
    </p>
  {/if}
  {#snippet footer(close)}
    <button class="btn is-primary" type="button" onclick={close}>{t('attachmentDismiss')}</button>
    {#if selected !== null}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve 添付の配信 URL -->
      <a
        class="btn"
        href={url(selected)}
        download={selected.file_name}
        aria-label={t('attachmentDownloadLabel', { name: selected.file_name })}>{t('attachmentDownloadAction')}</a
      >
      {#if canWrite && selected.deletable}
        <button
          class="btn"
          type="button"
          disabled={deleting}
          onclick={(event) => selected !== null && void remove(selected, event.currentTarget)}
          >{t('attachmentDeleteAction')}</button
        >
      {/if}
    {/if}
  {/snippet}
</Dialog>
<ConfirmDialog
  bind:this={confirm}
  title={t('attachmentDeleteTitle')}
  confirmLabel={t('attachmentDeleteAction')}
  cancelLabel={t('cancel')}
  danger
>
  <p class="file-name">{deleteFileName}</p>
  <p>{t('attachmentDeleteWarning')}</p>
</ConfirmDialog>
