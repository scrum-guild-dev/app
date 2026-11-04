<script lang="ts">
  import { tick } from 'svelte';
  import { focusPageHeading } from '../focus-heading.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の celebrate。エピックをクリアしたときの演出（components.css の .celebrate）。判子が1回押されるだけで、
  // 動きは CSS の hanko-press 1回。動きを減らす設定（prefers-reduced-motion: reduce）では出さず、呼び出し側がトーストだけにする
  // （prefersReducedMotion() で見分ける）。取り消しには出さない。
  // 開くとき、閉じるボタンへフォーカスを移す。シートは role="dialog"、aria-modal で、題を名前にする（額は題の下の文）。
  // Esc、背景、閉じるボタンで閉じる。閉じたら onclosed の先へフォーカスを移す（渡されなければ、開く前の要素、戻せなければ画面の見出し）
  let {
    open = $bindable(false),
    title,
    reward,
    onclosed,
  }: {
    open?: boolean;
    // エピックの題
    title: string;
    // 額の文。「<参加者>の 3 人に 300 XP」
    reward: string;
    // 閉じた後にフォーカスを置く先。画面が渡す（押した主ボタンは、読み直しで別のボタンに替わっているため）
    onclosed?: () => void;
  } = $props();

  const id = $props.id();
  const titleId = `${id}-title`;
  const rewardId = `${id}-reward`;
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
    if (onclosed) {
      onclosed();
      return;
    }
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
    } else if (event.key === 'Tab') {
      // 押せるのは閉じるボタンだけ。背後の画面（「取り消す」など）へフォーカスを出さない
      event.preventDefault();
      closeButton?.focus();
    }
  }
</script>

<svelte:window onkeydown={open ? onkeydown : undefined} />

{#if open}
  <!-- 背景を押すと閉じる。キーボードでは Esc と閉じるボタン。Tab は閉じるボタンに留める -->
  <div
    class="celebrate"
    data-celebrate
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) void close();
    }}
  >
    <div class="celebrate-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={rewardId}>
      <span class="celebrate-stamp" aria-hidden="true">{t('epicCelebrateStamp')}</span>
      <p class="celebrate-title" id={titleId}>{title}</p>
      <p class="celebrate-reward" id={rewardId}>{reward}</p>
      <button class="btn" type="button" bind:this={closeButton} onclick={() => void close()}>{t('close')}</button>
    </div>
  </div>
{/if}
