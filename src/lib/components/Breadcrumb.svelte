<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';

  // 上の帯の「組織 › ワークスペース › 画面」。kit.js の breadcrumbHtml と同じ並び。
  // href のある項目は最初の画面へのリンク、current の項目は今の画面（リンクにしない）。長い名前は1行に収めて省略し、全文は title に残す
  let { crumbs }: { crumbs: { label: string; href?: string; current?: boolean }[] } = $props();
</script>

<nav class="breadcrumb" aria-label={t('breadcrumb')}>
  <ol>
    {#each crumbs as crumb, index (index)}
      <li>
        {#if index > 0}<span class="breadcrumb-sep" aria-hidden="true">›</span>{/if}
        {#if crumb.current}
          <span class="breadcrumb-item" aria-current="page" title={crumb.label}>{crumb.label}</span>
        {:else if crumb.href}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href は AppShell が resolve した経路 -->
          <a class="breadcrumb-item" href={crumb.href} title={crumb.label}>{crumb.label}</a>
        {:else}
          <span class="breadcrumb-item" title={crumb.label}>{crumb.label}</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
