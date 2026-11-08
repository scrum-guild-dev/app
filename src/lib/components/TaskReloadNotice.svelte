<script lang="ts">
  import { tick } from 'svelte';
  import { focusIsFree, focusPageHeading } from '../focus-heading.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 行とカードの「⋯」から消した（戻した）後の読み直しが失敗し、一覧が前のまま残っているときの印（#979）。
  // トーストは消えるので、大事なこと（消した行がまだ見えている）を画面に残す。部品はカタログの「もう一度試す」付きの
  // .callout.is-warn と .callout-actions（設定の節の読み直しの失敗、SectionBoundary と同じ形）。
  // 失敗の知らせ（role="alert"）は本文の span に付け、読み直している間の状態（role="status"）は入れ子にしない。
  // 「もう一度試す」は、読み直している間は aria-disabled にして、押しても無視する（フォーカスを残す）。
  // 読み直せたら、画面が印を外す（一覧が新しくなる）。押したボタンが消えてフォーカスが body に落ちないよう、見出しへ移す
  let { message, onretry }: { message: string; onretry: () => Promise<boolean> } = $props();

  let state = $state<'idle' | 'retrying' | 'failedAgain'>('idle');

  async function retry(): Promise<void> {
    if (state === 'retrying') return;
    state = 'retrying';
    const ok = await onretry();
    state = ok ? 'idle' : 'failedAgain';
    if (!ok) return;
    await tick();
    if (focusIsFree()) focusPageHeading();
  }

  const status = $derived(state === 'retrying' ? t('retrying') : state === 'failedAgain' ? t('retryFailed') : '');
</script>

<div class="callout is-warn" data-task-reload-notice>
  <Icon name="alert" /><span role="alert">{message}</span>
  <div class="callout-actions">
    <button class="btn is-sm" type="button" aria-disabled={state === 'retrying'} onclick={retry}>{t('retry')}</button>
    <span class="field-hint" role="status">{status}</span>
  </div>
</div>
