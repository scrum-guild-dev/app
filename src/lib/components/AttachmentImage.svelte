<script lang="ts">
  import { getContext } from 'svelte';
  import { ATTACHMENT_DELETIONS, type AttachmentDeletions } from '../attachment-context.ts';
  import { t } from '../vocabulary.svelte.ts';

  let { src, alt }: { src: string; alt: string } = $props();
  // 失敗は URL ごとに保持する。別の本文で同じ位置の画像が替われば、再び読み込む。
  const deleted = getContext<AttachmentDeletions | undefined>(ATTACHMENT_DELETIONS);
  let failed = $state<string | null>(null);
</script>

{#if failed === src || deleted?.urls.includes(src)}
  <span class="doc-literal" role="status">{t('attachmentImageMissing')}{alt ? `（${alt}）` : ''}</span>
{:else}
  <img {src} {alt} loading="lazy" onerror={() => (failed = src)} />
{/if}
