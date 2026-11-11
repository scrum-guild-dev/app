<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import { navState } from '../nav-collapse.svelte.ts';
  import { loadingShapeCounts, loadingShapeHasActions, type LoadingShape } from '../loading-shape.ts';
  import BrandSymbol from './BrandSymbol.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';

  // 移る間の、読み込み中の表示。文字ではなく、読み込んだ後の画面に近い骨組み（スケルトン）を出す。
  // 行き先が組織の枠（/<slug> の下）なら、枠と同じ部品（.app、.binding、.topbar、.content）で左のメニューと上の帯を出し、
  // 本文は行き先の画面の組み（shape。src/lib/loading-shape.ts）に近い形にする。読み込んだ後に画面の組みと位置が変わらないように、
  // 本文の2列や設定の節は、本物と同じ部品（.layout-aside、.layout-wiki、.settings、.board、.lanes）を使う。
  // 行き先が枠の外（ログイン、組織の選択など。shape が null）なら、枠の外と同じ紙を出す。
  // 骨組みは装飾なので aria-hidden。見出しは読み上げと画面の構造のために見えないまま置く。
  // 読み上げの領域（role="status"）と、出す遅れ（短い読み込みでは出さない）は呼ぶ側の root レイアウトが持つ
  let { shape = null }: { shape?: LoadingShape | null } = $props();
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('loading'), app: t('appName') })}</title>
</svelte:head>

{#if shape}
  <div class="app skeleton-frame" data-nav-collapsed={navState.collapsed ? 'true' : undefined} data-shape={shape}>
    <div class="binding" aria-hidden="true">
      <div class="binding-inner">
        <div class="binding-head">
          <span class="brand"><BrandSymbol /></span>
          <span class="skeleton-line is-org-name"></span>
        </div>
        <div class="binding-body">
          <div class="skeleton skeleton-nav">
            <span class="skeleton-line"></span>
            <span class="skeleton-line is-short"></span>
          </div>
          <div class="skeleton skeleton-nav is-group">
            <span class="skeleton-line is-group-label"></span>
            <span class="skeleton-line is-org"></span>
            <span class="skeleton-line is-short"></span>
            <span class="skeleton-line"></span>
            <span class="skeleton-line is-short"></span>
            <span class="skeleton-line"></span>
            <span class="skeleton-line is-short"></span>
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
        {#if shape !== 'task'}
          <!-- 読む画面（today と aside の形）は、読み込んだ後と同じく本文の幅を止める（PageHead の reading） -->
          <div class="page-head skeleton" class:is-reading={shape === 'today' || shape === 'aside'} aria-hidden="true">
            <span class="skeleton-line is-eyebrow"></span>
            <div class="page-head-row">
              <span class="skeleton-line is-title"></span>
              {#if loadingShapeHasActions(shape)}<span class="skeleton-line is-button"></span>{/if}
            </div>
            <span class="skeleton-line is-stats"></span>
          </div>
        {/if}
        <div class="skeleton-body" aria-hidden="true">
          {#if shape === 'today'}
            <div class="layout-main skeleton">
              <span class="skeleton-line is-heading"></span>
              <span class="skeleton-line is-card"></span>
              <span class="skeleton-line is-heading"></span>
              <span class="skeleton-line is-card"></span>
            </div>
          {:else if shape === 'aside'}
            <div class="layout-aside">
              <div class="layout-main skeleton">
                <span class="skeleton-line is-heading"></span>
                <span class="skeleton-line is-card"></span>
                <span class="skeleton-line is-heading"></span>
                <span class="skeleton-line is-card"></span>
              </div>
              <div class="layout-side"><span class="skeleton-line is-panel"></span></div>
            </div>
          {:else if shape === 'tree'}
            <div class="skeleton">
              <div class="skeleton-row">
                <span class="skeleton-line is-input"></span>
                {#each { length: loadingShapeCounts.treeSelects }, i (i)}<span class="skeleton-line is-select"
                  ></span>{/each}
              </div>
              {#each { length: loadingShapeCounts.treeRows }, i (i)}<span class="skeleton-line is-item"></span>{/each}
            </div>
          {:else if shape === 'board'}
            <div class="board-wrap">
              <div class="board">
                {#each { length: loadingShapeCounts.boardColumns }, i (i)}
                  <div class="board-col skeleton">
                    <span class="skeleton-line is-short"></span>
                    <span class="skeleton-line is-card"></span>
                    <span class="skeleton-line is-card"></span>
                  </div>
                {/each}
              </div>
            </div>
          {:else if shape === 'plan'}
            <div class="skeleton">
              <span class="skeleton-line is-chart"></span>
              <div class="lanes">
                {#each { length: loadingShapeCounts.planLanes }, i (i)}<span class="skeleton-line is-lane"
                  ></span>{/each}
              </div>
            </div>
          {:else if shape === 'settings'}
            <div class="settings">
              {#each { length: loadingShapeCounts.settingSections }, i (i)}
                <div class="setting">
                  <div class="skeleton">
                    <span class="skeleton-line is-heading"></span>
                    <span class="skeleton-line"></span>
                    <span class="skeleton-line is-short"></span>
                  </div>
                  <span class="skeleton-line is-card"></span>
                </div>
              {/each}
            </div>
          {:else if shape === 'wiki'}
            <div class="layout-wiki">
              <div class="wiki-side skeleton">
                <span class="skeleton-line is-short"></span>
                <span class="skeleton-line is-input"></span>
                <span class="skeleton-line is-button"></span>
              </div>
              <span class="skeleton-line is-panel"></span>
            </div>
          {:else if shape === 'task'}
            <div class="skeleton">
              <div class="skeleton-row is-end">
                {#each { length: loadingShapeCounts.taskButtons }, i (i)}<span class="skeleton-line is-button"
                  ></span>{/each}
              </div>
              <span class="skeleton-line is-title"></span>
              {#each { length: loadingShapeCounts.taskFields }, i (i)}
                <div class="skeleton-row">
                  <span class="skeleton-line is-label"></span>
                  <span class="skeleton-line is-value"></span>
                </div>
              {/each}
              <span class="skeleton-line is-card"></span>
              <span class="skeleton-line is-card"></span>
            </div>
          {:else}
            <div class="skeleton">
              <span class="skeleton-line is-heading"></span>
              {#each { length: loadingShapeCounts.listRows }, i (i)}<span class="skeleton-line is-item"></span>{/each}
            </div>
          {/if}
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
