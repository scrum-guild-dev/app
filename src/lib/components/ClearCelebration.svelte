<script lang="ts">
  import { tick } from 'svelte';
  import { focusPageHeading } from '../focus-heading.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の celebrate。エピックをクリアしたときの演出（components.css の .celebrate）。判子が1回押されるだけで、
  // 動きは CSS の hanko-press 1回。動きを減らす設定（prefers-reduced-motion: reduce）では出さず、呼び出し側がトーストだけにする
  // （prefersReducedMotion() で見分ける）。取り消しには出さない。
  // 開くとき、閉じるボタンへフォーカスを移して読み上げ（role="status"）に任せ、Esc、背景、閉じるボタンで閉じる。
  // 閉じたら、開く前にフォーカスのあった要素へ戻し、戻せなければ画面の見出しへ移す
  let {
    open = $bindable(false),
    title,
    reward,
  }: {
    open?: boolean;
    // エピックの題
    title: string;
    // 額の文。「<参加者>の 3 人に 300 XP」
    reward: string;
  } = $props();

  let closeButton = $state<HTMLButtonElement>();
  let opener: HTMLElement | null = null;

  export function show(trigger?: HTMLElement | null): void {
    opener = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    open = true;
  }

  async function close(): Promise<void> {
    if (!open) return;
    open = false;
    await tick();
    const target = opener;
    opener = null;
    target?.focus();
    if (target === null || document.activeElement !== target) focusPageHeading();
  }

  $effect(() => {
    if (open) closeButton?.focus();
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      void close();
    }
  }
</script>

<svelte:window onkeydown={open ? onkeydown : undefined} />

{#if open}
  <!-- 背景を押して閉じるのは、押し始めと離した所の両方が背景のとき。キーボードでは Esc と閉じるボタン -->
  <div
    class="celebrate"
    data-celebrate
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) void close();
    }}
  >
    <div class="celebrate-sheet" role="status">
      <span class="celebrate-stamp" aria-hidden="true">{t('epicCelebrateStamp')}</span>
      <p class="celebrate-title">{title}</p>
      <p class="celebrate-reward">{reward}</p>
      <button class="btn" type="button" bind:this={closeButton} onclick={() => void close()}>{t('close')}</button>
    </div>
  </div>
{/if}
