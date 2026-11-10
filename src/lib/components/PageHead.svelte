<script lang="ts" module>
  import type { IconName } from '../icons.ts';

  // 集計の1項目。count が 0 のときは tone を外して素の色で出す
  export type Tally = { tone?: 'danger' | 'warn' | 'ok'; icon?: IconName; label: string; count: number };
</script>

<script lang="ts">
  import { getContext, onMount, type Snippet } from 'svelte';
  import { MOBILE_PAGE_HEAD, type MobilePageHead } from '../mobile-page-head.ts';
  import Icon from './Icon.svelte';
  import NarrowDisclosure from './NarrowDisclosure.svelte';

  // kit.js の pageHead。画面の見出し（h1）、上の小さな見出し、集計、右上の操作。
  // focusable は、画面を移った後や、操作した行が消えた後に見出しへフォーカスを置く画面（作ったワークスペースの画面、今日やること）が付ける。
  // meta は集計の下に置く1行（バックログの画面のチーム全体の経験値。kit.js の pageHead の meta）
  let {
    title,
    eyebrow,
    tallies = [],
    actions,
    meta,
    focusable = false,
    narrowSummary,
  }: {
    title: string;
    eyebrow?: string;
    tallies?: Tally[];
    actions?: Snippet;
    meta?: Snippet;
    focusable?: boolean;
    narrowSummary?: string;
  } = $props();

  const mobileHead = getContext<MobilePageHead | undefined>(MOBILE_PAGE_HEAD);
  // 同じ画面の失敗表示にも PageHead がある場合は、最初の見出しだけが入口を持つ。
  const headId = Symbol('page-head');
  onMount(() => mobileHead?.register(headId));

  const compactSummary = $derived(tallies.length > 1 || meta ? narrowSummary : undefined);
</script>

<header class="page-head" class:is-compact={!!compactSummary}>
  {#if eyebrow}<span class="page-eyebrow">{eyebrow}</span>{/if}
  <div class="page-head-row">
    <!-- tabindex="-1" は、プログラムからフォーカスを置くため（キーボードの Tab 順には入らない）。値は -1 か未指定だけ -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <h1 class="page-title" tabindex={focusable ? -1 : undefined}>{title}</h1>
    {#if mobileHead?.narrow && mobileHead.owns(headId)}{@render mobileHead.tools()}{/if}
    {#if actions}<div class="page-actions">{@render actions()}</div>{/if}
  </div>
  {#snippet counts(items: Tally[])}
    <dl class="tally">
      <!-- 同じラベルが2つあっても落ちないよう、keyは添字にする（並びは画面が決め、入れ替えない） -->
      {#each items as tally, index (index)}
        <div class={tally.count && tally.tone ? `is-${tally.tone}` : undefined}>
          <dt>
            {#if tally.icon}<Icon name={tally.icon} />{/if}{tally.label}
          </dt>
          <dd>{tally.count}</dd>
        </div>
      {/each}
    </dl>
  {/snippet}
  {#if compactSummary}
    <div class="page-head-metrics">
      {#if tallies.length > 0}{@render counts(tallies.slice(0, 1))}{/if}
      <NarrowDisclosure label={compactSummary}>
        {#if tallies.length > 1}{@render counts(tallies.slice(1))}{/if}
        {#if meta}<div class="page-head-meta">{@render meta()}</div>{/if}
      </NarrowDisclosure>
    </div>
  {:else}
    {#if tallies.length > 0}{@render counts(tallies)}{/if}
    {#if meta}{@render meta()}{/if}
  {/if}
</header>
