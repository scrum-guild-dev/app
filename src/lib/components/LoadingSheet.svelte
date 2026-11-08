<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';

  // 枠の外の画面から移る間の、読み込み中の表示。文字ではなく、読み込んだ後の紙に近い骨組み（スケルトン）を出す。
  // 骨組みは装飾なので aria-hidden。見出しは読み上げと画面の構造のために見えないまま置く。
  // 読み上げの領域（role="status"）と、出す遅れ（短い読み込みでは出さない）は呼ぶ側の root レイアウトが持つ
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('loading'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand>
    <h1 class="visually-hidden">{t('loading')}</h1>
    <div class="skeleton" aria-hidden="true">
      <span class="skeleton-line is-title"></span>
      <span class="skeleton-line"></span>
      <span class="skeleton-line is-short"></span>
      <span class="skeleton-line is-block"></span>
    </div>
  </GateSheet>
</Gate>
