<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { ATTACHMENTS_PER_SAVE } from '../../shared/attachment.ts';
  import { ATTACHMENT_MAX_BYTES } from '../../shared/operations/attachment/index.ts';
  import {
    attachmentMarkdown,
    AttachmentUploadError,
    moveAttachmentAnchor,
    uploadAttachment,
  } from '../attachment-upload.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  let {
    value = $bindable(''),
    input = $bindable<HTMLTextAreaElement>(),
    attachmentIds = $bindable<string[]>([]),
    uploading = $bindable(false),
    slug,
    workspaceId,
    id,
    readonly = false,
    placeholder,
    invalid = false,
    describedby,
    oninput,
    dataCommentInput,
  }: {
    value: string;
    input?: HTMLTextAreaElement;
    attachmentIds?: string[];
    uploading?: boolean;
    slug: string;
    workspaceId: string;
    id?: string;
    readonly?: boolean;
    placeholder?: string;
    invalid?: boolean;
    describedby?: string;
    oninput?: () => void;
    dataCommentInput?: string;
  } = $props();

  type Upload = {
    key: number;
    file: File;
    anchor: number;
    percent: number;
    state: 'queued' | 'uploading' | 'done' | 'error';
    error: string | null;
    controller: AbortController;
    attachmentId?: string;
  };
  let files = $state<Upload[]>([]);
  let picker: HTMLInputElement;
  let sequence = 0;
  let pumping = false;
  let destroyed = false;
  let quota = $state(false);
  let notice = $state<string | null>(null);
  let previous = value;
  const size = (file: File) => (file.size / 1_048_576).toFixed(2);
  const active = () => files.filter((file) => file.state === 'uploading' || file.state === 'queued');

  $effect(() => {
    uploading = files.some((file) => file.state === 'uploading' || file.state === 'queued');
  });
  $effect(() => {
    if (value !== previous) {
      for (const file of files) file.anchor = moveAttachmentAnchor(previous, value, file.anchor);
      previous = value;
    }
  });
  onDestroy(() => {
    destroyed = true;
    for (const file of files) file.controller.abort();
    uploading = false;
  });

  function changed(): void {
    // Run synchronously, before an upload completion can insert using an old position.
    for (const file of files) file.anchor = moveAttachmentAnchor(previous, value, file.anchor);
    previous = value;
    oninput?.();
  }

  function add(list: FileList | File[]): void {
    if (readonly || quota) return;
    notice = null;
    const anchor = input?.selectionStart ?? value.length;
    for (const file of Array.from(list)) {
      if (attachmentIds.length + active().length >= ATTACHMENTS_PER_SAVE) {
        notice = t('attachmentTooMany');
        break;
      }
      const error =
        file.size > ATTACHMENT_MAX_BYTES
          ? t('attachmentTooLarge', { size: size(file) })
          : file.size === 0
            ? t('attachmentEmpty')
            : null;
      files.push({
        key: sequence++,
        file,
        anchor,
        percent: 0,
        state: error ? 'error' : 'queued',
        error,
        controller: new AbortController(),
      });
    }
    void pump();
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (!destroyed) {
        const file = files.find((entry) => entry.state === 'queued');
        if (!file) break;
        file.state = 'uploading';
        try {
          const uploaded = await uploadAttachment(file.file, {
            slug,
            workspaceId,
            signal: file.controller.signal,
            progress: (percent) => {
              file.percent = percent;
            },
          });
          if (destroyed || file.controller.signal.aborted) continue;
          attachmentIds = [...attachmentIds, uploaded.id];
          file.attachmentId = uploaded.id;
          file.state = 'done';
          const markdown = attachmentMarkdown(uploaded, slug);
          if (markdown !== null) {
            const at = Math.min(file.anchor, value.length);
            const start = input?.selectionStart ?? 0;
            const end = input?.selectionEnd ?? 0;
            value = value.slice(0, at) + markdown + value.slice(at);
            for (const other of files) if (other.anchor >= at) other.anchor += markdown.length;
            previous = value;
            oninput?.();
            await tick();
            input?.setSelectionRange(
              start >= at ? start + markdown.length : start,
              end >= at ? end + markdown.length : end,
            );
          }
        } catch (error) {
          if (destroyed) break;
          const code = error instanceof AttachmentUploadError ? error.code : 'network';
          file.error = t(
            code === 'cancelled'
              ? 'attachmentCancelled'
              : code === 'attachment_quota_exceeded'
                ? 'attachmentQuota'
                : 'attachmentFailed',
          );
          file.state = 'error';
          if (code === 'attachment_quota_exceeded') {
            quota = true;
            for (const queued of files.filter((entry) => entry.state === 'queued')) {
              queued.error = t('attachmentQuota');
              queued.state = 'error';
            }
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  function cancel(file: Upload): void {
    if (file.state === 'uploading' || file.state === 'queued') file.controller.abort();
    files = files.filter((other) => other.key !== file.key);
  }

  function drop(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files') && !event.dataTransfer?.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (!readonly && !quota && event.dataTransfer) add(event.dataTransfer.files);
  }
</script>

<div class="markdown-editor" aria-busy={uploading}>
  <textarea
    class="textarea"
    {id}
    bind:this={input}
    bind:value
    {readonly}
    {placeholder}
    aria-invalid={invalid}
    aria-describedby={describedby}
    data-comment-input={dataCommentInput}
    oninput={(event) => {
      value = event.currentTarget.value;
      changed();
    }}
    ondragover={(event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    }}
    ondrop={drop}
    onpaste={(event) => {
      if (!readonly && event.clipboardData?.files.length) {
        event.preventDefault();
        add(event.clipboardData.files);
      }
    }}></textarea>
  <div
    class="dropzone"
    class:is-disabled={readonly || quota}
    role="region"
    aria-label={t('attachmentDrop')}
    ondrop={drop}
    ondragover={(event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    }}
  >
    <Icon name="upload" />
    <span class="dropzone-text"><b>{t('attachmentDrop')}</b><span>{t('attachmentDropHint')}</span></span>
    <input
      bind:this={picker}
      type="file"
      multiple
      hidden
      disabled={readonly || quota}
      onchange={(event) => {
        if (event.currentTarget.files) add(event.currentTarget.files);
        event.currentTarget.value = '';
      }}
    />
    <button type="button" class="btn is-sm" disabled={readonly || quota} onclick={() => picker.click()}
      >{t('attachmentChoose')}</button
    >
  </div>
  {#if quota}<p class="field-error" role="alert">{t('attachmentQuota')}</p>{/if}
  {#if notice}<p class="field-error" role="alert">{notice}</p>{/if}
  {#each files.filter((file) => file.state !== 'done' || attachmentIds.includes(file.attachmentId ?? '')) as file (file.key)}
    <div class="file-row" class:is-error={file.error !== null}>
      <Icon name={file.error ? 'alert' : file.state === 'done' ? 'file' : 'upload'} />
      <div class="file-main">
        <span class="file-name">{file.file.name}</span>
        <span class="file-meta" role={file.error ? 'alert' : undefined}>
          {file.error ??
            (file.state === 'done'
              ? t('attachmentReady', { size: size(file.file) })
              : t('attachmentUploading', { percent: file.percent, size: size(file.file) }))}
        </span>
        {#if file.state === 'uploading' || file.state === 'queued'}
          <progress class="attachment-progress" value={file.percent} max="100" aria-label={file.file.name}></progress>
        {/if}
      </div>
      {#if file.state !== 'done'}
        <div class="file-actions">
          <button
            type="button"
            class="btn is-sm is-quiet"
            aria-label={file.error ? undefined : t('attachmentCancelLabel', { name: file.file.name })}
            onclick={() => cancel(file)}>{t(file.error ? 'attachmentDismiss' : 'attachmentCancel')}</button
          >
        </div>
      {/if}
    </div>
  {/each}
</div>
