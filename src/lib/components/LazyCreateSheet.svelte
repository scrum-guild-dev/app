<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { dismissToast, pauseToast, showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type CreateSheet from './CreateSheet.svelte';

  let { slug, workspaceId, id }: { slug: string; workspaceId: string; id: string } = $props();
  let Sheet = $state<typeof CreateSheet>();
  let sheet = $state<ReturnType<typeof CreateSheet>>();
  let loading = false;
  let generation = 0;
  let alive = true;
  let notice: number | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTrigger: HTMLButtonElement | undefined;

  function clearNotice() {
    clearTimeout(noticeTimer);
    if (notice !== undefined) dismissToast(notice);
    notice = undefined;
  }

  function cancelPending() {
    generation++;
    loading = false;
    activeTrigger?.removeAttribute('aria-busy');
    activeTrigger = undefined;
    clearNotice();
  }

  beforeNavigate(cancelPending);
  onDestroy(() => {
    alive = false;
    cancelPending();
  });

  // 作るシートと本文の編集機能は、最初に押されたときだけ読む。
  // 読み込み中の連打はまとめ、移動した後に古いシートを開かない。失敗したら次のクリックで再試行できる。
  export async function show(trigger: HTMLButtonElement): Promise<void> {
    if (loading) return;
    loading = true;
    activeTrigger = trigger;
    trigger.setAttribute('aria-busy', 'true');
    noticeTimer = setTimeout(() => {
      notice = showToast(t('loading'));
      // 取得中の知らせは、通常の4秒では消さず、完了・移動・破棄でclearNoticeが閉じる。
      pauseToast(notice);
    }, 300);
    const current = generation;
    try {
      let component = Sheet;
      if (!component) {
        try {
          component = (await import('./CreateSheet.svelte')).default;
        } catch {
          if (alive && generation === current) {
            showToast(t('loadFailedTitle'), 'alert', { label: t('reloadPage'), run: () => location.reload() });
          }
          return;
        }
      }
      if (!alive || generation !== current || !trigger.isConnected) return;
      Sheet = component;
      await tick();
      if (!alive || generation !== current || !trigger.isConnected) return;
      if (!sheet) {
        showToast(t('createSheetOpenFailed'), 'alert', { label: t('reloadPage'), run: () => location.reload() });
        return;
      }
      try {
        await sheet.show(trigger);
      } catch {
        if (alive && generation === current) {
          showToast(t('createSheetOpenFailed'), 'alert', { label: t('reloadPage'), run: () => location.reload() });
        }
      }
    } finally {
      if (generation === current) {
        clearNotice();
        loading = false;
        trigger.removeAttribute('aria-busy');
        activeTrigger = undefined;
      }
    }
  }
</script>

{#if Sheet}<Sheet {slug} {workspaceId} {id} bind:this={sheet} />{:else}<span {id} hidden></span>{/if}
