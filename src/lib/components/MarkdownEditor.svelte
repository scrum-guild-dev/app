<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { ATTACHMENTS_PER_SAVE } from '../../shared/attachment.ts';
  import { ATTACHMENT_MAX_BYTES } from '../../shared/operations/attachment/index.ts';
  import {
    attachmentMarkdown,
    clipboardTextToInsert,
    AttachmentUploadError,
    moveAttachmentAnchor,
    moveMarkdownInsertion,
    resolveInputEdit,
    type TextEditRange,
    type MarkdownInsertion,
    uploadAttachment,
  } from '../attachment-upload.ts';
  import { filterSlashItems, moveSlashSelection, slashEdit, slashQuery, type SlashItem } from '../markdown-slash.ts';
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
    insertion?: MarkdownInsertion;
  };
  const uid = $props.id();
  const quotaId = `${uid}-quota`;
  let files = $state<Upload[]>([]);
  let picker: HTMLInputElement;
  let sequence = 0;
  let pumping = false;
  let destroyed = false;
  let quota = $state(false);
  let notice = $state<string | null>(null);
  let removalNotice = $state('');
  let previous = value;
  let pendingInput: (TextEditRange & { before: string; inputType: string }) | undefined;
  // 「/」の小窓。候補があるあいだだけ開く。欄に role は付けず（textarea の role は textbox）、選んでいる項目は aria-activedescendant で指す
  const menuId = `${uid}-slash`;
  let slashItems = $state<SlashItem[]>([]);
  let slashAt = $state(0);
  let slashText = '';
  let composing = false;
  const slashOpen = $derived(slashItems.length > 0);
  const slashStatus = $derived(
    slashOpen
      ? t('slashStatus', { count: slashItems.length, name: t(slashItems[slashAt]?.label ?? 'slashHeading') })
      : '',
  );
  const optionId = (item: SlashItem) => `${menuId}-${item.key}`;
  $effect(() => {
    if (readonly) closeSlash();
  });
  // 矢印で選んだ項目が、小窓の中の見える範囲に入るようにする（aria-activedescendant は見た目をスクロールしない）。
  // scrollIntoView は引き出しやページも動かすので、小窓の scrollTop だけを直す。矢印で選んだときだけ呼ぶ
  function revealSlashItem(): void {
    const item = slashItems[slashAt];
    const option = item ? document.getElementById(optionId(item)) : null;
    const menu = option?.parentElement;
    if (!option || !menu) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }
  const size = (file: File) => (file.size / 1_048_576).toFixed(2);
  const active = () => files.filter((file) => file.state === 'uploading' || file.state === 'queued');

  $effect(() => {
    uploading = files.some((file) => file.state === 'uploading' || file.state === 'queued');
  });
  $effect(() => {
    if (value !== previous) synchronizePositions();
  });
  onDestroy(() => {
    destroyed = true;
    for (const file of files) file.controller.abort();
    uploading = false;
  });

  function updatePositions(before: string, after: string, edit?: TextEditRange): void {
    for (const file of files) {
      if (edit) {
        const delta = after.length - before.length;
        if (file.anchor >= edit.end) file.anchor += delta;
        else if (file.anchor >= edit.start) file.anchor = edit.end + delta;
      } else file.anchor = moveAttachmentAnchor(before, after, file.anchor);
      if (file.insertion) file.insertion = moveMarkdownInsertion(before, after, file.insertion, edit);
    }
  }

  function applyEdit(start: number, end: number, text: string): void {
    const delta = text.length - (end - start);
    value = value.slice(0, start) + text + value.slice(end);
    for (const file of files) {
      if (file.anchor >= end) file.anchor += delta;
      else if (file.anchor >= start) file.anchor = start + text.length;
      if (file.insertion) {
        if (end <= file.insertion.start) file.insertion.start += delta;
        else if (start < file.insertion.start + file.insertion.text.length) file.insertion = undefined;
      }
    }
    previous = value;
    oninput?.();
  }

  function synchronizePositions(): void {
    const edit = pendingInput?.before === previous ? resolveInputEdit(previous, value, pendingInput) : undefined;
    pendingInput = undefined;
    updatePositions(previous, value, edit);
    previous = value;
  }

  function changed(): void {
    // The reactive effect may run before a delegated input handler; both consume the same actual edit.
    synchronizePositions();
    oninput?.();
  }

  function add(list: FileList | File[], anchor = input?.selectionStart ?? value.length): void {
    if (readonly || quota) return;
    notice = null;
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
            applyEdit(at, at, markdown);
            file.insertion = { start: at, text: markdown };
            await tick();
            input?.setSelectionRange(
              start >= at ? start + markdown.length : start,
              end >= at ? end + markdown.length : end,
            );
            if (slashOpen) updateSlash();
          }
        } catch (error) {
          if (destroyed) break;
          const code = error instanceof AttachmentUploadError ? error.code : 'network';
          file.error = t(
            code === 'cancelled'
              ? 'attachmentCancelled'
              : code === 'attachment_quota_exceeded'
                ? 'attachmentQuotaFile'
                : 'attachmentFailed',
          );
          file.state = 'error';
          if (code === 'attachment_quota_exceeded') {
            quota = true;
            for (const queued of files.filter((entry) => entry.state === 'queued')) {
              queued.error = t('attachmentQuotaFile');
              queued.state = 'error';
            }
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  async function remove(file: Upload): Promise<void> {
    if (readonly) return;
    let start = input?.selectionStart ?? 0;
    let end = input?.selectionEnd ?? 0;
    attachmentIds = attachmentIds.filter((id) => id !== file.attachmentId);
    const insertion = file.insertion;
    let removedMarkdown = false;
    if (insertion && value.slice(insertion.start, insertion.start + insertion.text.length) === insertion.text) {
      const at = insertion.start;
      const tokenEnd = at + insertion.text.length;
      const selectionAfterRemoval = (position: number) =>
        position <= at ? position : Math.max(at, position - (tokenEnd - at));
      start = selectionAfterRemoval(start);
      end = selectionAfterRemoval(end);
      applyEdit(at, tokenEnd, '');
      removedMarkdown = true;
    }
    await finishRowAction(
      file,
      t(removedMarkdown ? 'attachmentRemovedImage' : 'attachmentRemovedKeepBody', { name: file.file.name }),
      start,
      end,
    );
  }

  async function finishRowAction(file: Upload, message: string, start: number, end: number): Promise<void> {
    // Clear and flush even when the same filename is acted on twice in succession.
    removalNotice = '';
    files = files.filter((other) => other.key !== file.key);
    await tick();
    if (destroyed) return;
    input?.focus();
    input?.setSelectionRange(start, end);
    removalNotice = message;
  }

  async function cancel(file: Upload): Promise<void> {
    const start = input?.selectionStart ?? 0;
    const end = input?.selectionEnd ?? 0;
    const error = file.state === 'error';
    if (file.state === 'uploading' || file.state === 'queued') file.controller.abort();
    await finishRowAction(
      file,
      t(error ? 'attachmentErrorClosed' : 'attachmentUploadCancelled', { name: file.file.name }),
      start,
      end,
    );
  }

  function closeSlash(): void {
    slashItems = [];
    slashAt = 0;
    slashText = '';
  }

  // 行頭の「/」にカーソルがあるあいだ、続けて打った文字で候補を絞る。変換中と読み取り専用では出さない
  function updateSlash(): void {
    if (!input || readonly || composing) return closeSlash();
    const query = slashQuery(input.value, input.selectionStart, input.selectionEnd);
    const items = query === null ? [] : filterSlashItems(query.query, (item) => t(item.label));
    if (query === null || items.length === 0) return closeSlash();
    // 開き直しと絞り込みの文字が変わったときは先頭を選ぶ
    if (!slashOpen || query.query !== slashText) slashAt = 0;
    slashText = query.query;
    slashItems = items;
    slashAt = Math.min(slashAt, items.length - 1);
  }

  function pickSlash(key: SlashItem['key'] | undefined): void {
    if (!input || readonly) return closeSlash();
    // 表示中の候補ではなく、今の本文とカーソルから取り直し、押した項目は key で探す（本文が動いた後の古い候補で別の項目を入れない）
    const query = slashQuery(input.value, input.selectionStart, input.selectionEnd);
    const item =
      query === null
        ? undefined
        : filterSlashItems(query.query, (entry) => t(entry.label)).find((entry) => entry.key === key);
    if (query === null || !item) return closeSlash();
    const edit = slashEdit(query, input.selectionStart, item, input.value.charAt(input.selectionStart));
    applyEdit(edit.start, edit.end, edit.text);
    // 貼り付けと同じく、続く操作がこの位置から始まるよう、選択を同期して置く
    input.value = value;
    input.setSelectionRange(edit.caret, edit.caret);
    closeSlash();
    input.focus();
  }

  // 小窓が開いているときのキー。上下で選び、Enter で入れ、Esc で閉じる（Tab は奪わない）。変換中は何もしない
  function slashKeydown(event: KeyboardEvent): void {
    if (!slashOpen || composing || event.isComposing || event.keyCode === 229) return;
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      slashAt = moveSlashSelection(slashAt, slashItems.length, event.key === 'ArrowDown' ? 1 : -1);
      void tick().then(revealSlashItem);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // カーソルが「/」の行を離れていたら、小窓を閉じて普通の改行に任せる
      if (input && slashQuery(input.value, input.selectionStart, input.selectionEnd) === null) return closeSlash();
      event.preventDefault();
      pickSlash(slashItems[slashAt]?.key);
    } else if (event.key === 'Escape') {
      // 「/」は文字として残す。引き出しは閉じない
      event.preventDefault();
      event.stopPropagation();
      closeSlash();
    }
  }

  function paste(event: ClipboardEvent): void {
    const clipboard = event.clipboardData;
    if (!clipboard?.files.length) return;
    event.preventDefault();
    if (readonly) return;
    const text = clipboardTextToInsert(clipboard.getData('text/plain'), Array.from(clipboard.files));
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    let caret = start;
    if (text !== '') {
      applyEdit(start, end, text);
      caret = start + text.length;
      // Update selection synchronously so uploads and the next keystroke use the pasted position.
      if (input) {
        input.value = value;
        input.setSelectionRange(caret, caret);
      }
    }
    if (slashOpen) updateSlash();
    add(clipboard.files, caret);
  }

  function drop(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files') && !event.dataTransfer?.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (!readonly && !quota && event.dataTransfer) add(event.dataTransfer.files);
  }
</script>

<div class="markdown-editor" aria-busy={uploading}>
  <span class="visually-hidden" role="status" aria-live="polite">{removalNotice}</span>
  <span class="visually-hidden" role="status" aria-live="polite">{slashStatus}</span>
  <div class="slash-wrap">
    <textarea
      class="textarea"
      {id}
      bind:this={input}
      {value}
      {readonly}
      {placeholder}
      aria-invalid={invalid}
      aria-controls={slashOpen ? menuId : undefined}
      aria-activedescendant={slashOpen && slashItems[slashAt] ? optionId(slashItems[slashAt]) : undefined}
      aria-describedby={[describedby, quota ? quotaId : undefined].filter(Boolean).join(' ') || undefined}
      data-comment-input={dataCommentInput}
      onbeforeinput={(event) => {
        const element = event.currentTarget;
        pendingInput = {
          before: element.value,
          start: element.selectionStart,
          end: element.selectionEnd,
          inputType: event.inputType,
        };
      }}
      oninput={(event) => {
        value = event.currentTarget.value;
        changed();
        updateSlash();
      }}
      onkeydown={slashKeydown}
      onkeyup={() => {
        if (slashOpen) updateSlash();
      }}
      onclick={() => {
        if (slashOpen) updateSlash();
      }}
      onblur={() => {
        composing = false;
        closeSlash();
      }}
      oncompositionstart={() => {
        composing = true;
        closeSlash();
      }}
      oncompositionend={() => {
        composing = false;
        updateSlash();
      }}
      ondragover={(event) => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      }}
      ondrop={drop}
      onpaste={paste}></textarea>
    <ul
      class="slash-menu"
      id={menuId}
      role="listbox"
      aria-label={t('slashMenuLabel')}
      hidden={!slashOpen}
      onmousedown={(event) => event.preventDefault()}
    >
      {#each slashItems as item, index (item.key)}
        <!-- キーボードの操作は欄が受ける（aria-activedescendant）。ここのクリックはポインターのため -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          class="slash-item"
          role="option"
          id={optionId(item)}
          aria-selected={index === slashAt}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => pickSlash(item.key)}
        >
          <span>{t(item.label)}</span><small aria-hidden="true">{item.mark}</small>
        </li>
      {/each}
    </ul>
  </div>
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
  {#if quota}<p class="field-error" id={quotaId} role="alert"><Icon name="alert" />{t('attachmentQuota')}</p>{/if}
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
      {#if file.state === 'done'}
        <div class="file-actions">
          <button
            type="button"
            class="btn is-sm is-quiet"
            disabled={readonly}
            aria-label={t('attachmentRemoveLabel', { name: file.file.name })}
            onclick={() => void remove(file)}>{t('attachmentRemove')}</button
          >
        </div>
      {:else}
        <div class="file-actions">
          <button
            type="button"
            class="btn is-sm is-quiet"
            aria-label={t(file.error ? 'attachmentErrorCloseLabel' : 'attachmentCancelLabel', { name: file.file.name })}
            onclick={() => void cancel(file)}>{t(file.error ? 'attachmentDismiss' : 'attachmentCancel')}</button
          >
        </div>
      {/if}
    </div>
  {/each}
</div>
