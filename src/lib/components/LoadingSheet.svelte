<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import { navState } from '../nav-collapse.svelte.ts';
  import BrandMark from './BrandMark.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';

  // 移る間の、読み込み中の表示。文字ではなく、読み込んだ後の画面に近い骨組み（スケルトン）を出す。
  // 行き先が組織の枠（/<slug> の下）なら、枠と同じ部品（.app、.binding、.topbar、.content）で左のメニューと上の帯と本文の形を出し、
  // 読み込んだ後に画面の大きさと位置が変わらないようにする。左のメニューの開閉も覚えた状態に合わせる。
  // 行き先が枠の外（ログイン、組織の選択など）なら、枠の外と同じ紙を出す。
  // 骨組みは装飾なので aria-hidden。見出しは読み上げと画面の構造のために見えないまま置く。
  // 読み上げの領域（role="status"）と、出す遅れ（短い読み込みでは出さない）は呼ぶ側の root レイアウトが持つ
  let { frame = false }: { frame?: boolean } = $props();
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('loading'), app: t('appName') })}</title>
</svelte:head>

{#if frame}
  <div class="app skeleton-frame" data-nav-collapsed={navState.collapsed ? 'true' : undefined}>
    <div class="binding" aria-hidden="true">
      <div class="binding-inner">
        <div class="binding-head"><span class="brand"><BrandMark /></span></div>
        <div class="binding-body">
          <span class="skeleton-line is-org"></span>
          <div class="skeleton skeleton-nav">
            <span class="skeleton-line"></span>
            <span class="skeleton-line is-short"></span>
            <span class="skeleton-line"></span>
            <span class="skeleton-line is-short"></span>
            <span class="skeleton-line"></span>
          </div>
        </div>
      </div>
    </div>
    <div class="sheet">
      <div class="topbar" aria-hidden="true">
        <span class="skeleton-line is-crumb"></span>
        <span class="skeleton-line is-search"></span>
        <span class="skeleton-line is-account"></span>
      </div>
      <main class="content">
        <h1 class="visually-hidden">{t('loading')}</h1>
        <div class="page-head skeleton" aria-hidden="true">
          <span class="skeleton-line is-eyebrow"></span>
          <span class="skeleton-line is-title"></span>
        </div>
        <div class="skeleton" aria-hidden="true">
          <span class="skeleton-line is-block"></span>
          <span class="skeleton-line is-block"></span>
          <span class="skeleton-line is-block"></span>
          <span class="skeleton-line is-short"></span>
        </div>
      </main>
    </div>
  </div>
{:else}
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
{/if}
