<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';

  // 上の帯の「組織 › ワークスペース › 画面」。kit.js の breadcrumbHtml と同じ並び。
  // href のある項目は最初の画面へのリンク。current の項目は今の画面（href が無ければリンクにしない。画面の名前が決まらない画面では、最後のワークスペースを href のまま今の画面にする）。長い名前は1行に収めて省略し、全文は title に残す
  let { crumbs }: { crumbs: { label: string; href?: string; current?: boolean }[] } = $props();
</script>

<nav class="breadcrumb" aria-label={t('breadcrumb')}>
  <ol>
    {#each crumbs as crumb, index (index)}
      <li>
        {#if index > 0}<span class="breadcrumb-sep" aria-hidden="true">›</span>{/if}
        {#if crumb.href}
          <!-- eslint-disable svelte/no-navigation-without-resolve -- href は AppShell が resolve した経路 -->
          <a
            class="breadcrumb-item"
            href={crumb.href}
            aria-current={crumb.current ? 'page' : undefined}
            title={crumb.label}>{crumb.label}</a
          >
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        {:else if crumb.current}
          <span class="breadcrumb-item" aria-current="page" title={crumb.label}>{crumb.label}</span>
        {:else}
          <span class="breadcrumb-item" title={crumb.label}>{crumb.label}</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
