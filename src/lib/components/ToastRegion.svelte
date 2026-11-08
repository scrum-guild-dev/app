<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from '../reduced-motion.ts';
  import {
    escapeToast,
    isFailureToast,
    modalState,
    pauseToast,
    resumeToast,
    runToastAction,
    toasts,
  } from '../toast.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の toast の置き場。showToast() で出す。画面の外側に1つ（+layout.svelte）と、各ダイアログの中に1つ（inDialog）置く。
  // モーダルのダイアログが開くと外側は inert になり、トップレイヤーに出し直しても（popover="manual" で確かめた）
  // 外側の要素は inert のままで、読み上げも届かない。そのためダイアログの中の領域に出し、外側の領域は隠す。
  // 領域は最初から置いておく（aria-live の領域は、後から足した要素を読み上げられないことがあるため）。
  // 操作の付いたトーストは、文の後ろにボタン（.toast-action）を出し、押したらそのトーストを消す。押すと画面が動くので、
  // ダイアログの中の領域には出さず、外側の領域だけに出す。ポインターかフォーカスがある間は、消すまでの時間を止める
  let { inDialog = false }: { inDialog?: boolean } = $props();

  // 消えるときは、出るのと同じ辺（下）へ opacity で --duration-fast（120ms）抜ける。動きを減らす設定では抜けない（今と同じ）。
  // CSS の animation: none は Web Animations の transition に効かないので、JS で見る
  function toastOut(node: Element) {
    const fast = parseFloat(getComputedStyle(node).getPropertyValue('--duration-fast'));
    return {
      duration: prefersReducedMotion() ? 0 : Number.isFinite(fast) ? fast : 120,
      easing: cubicOut,
      css: (t: number) => `opacity: ${t}; transform: translateY(${(1 - t) * 8}px)`,
    };
  }

  const shown = $derived(inDialog ? toasts.filter((toast) => toast.action === undefined) : toasts);
</script>

<div class="toasts" aria-live="polite" hidden={!inDialog && modalState.openCount > 0}>
  {#each shown as toast (toast.id)}
    {#if toast.action}
      {@const action = toast.action}
      <!-- Esc は中のボタンから届くキー。トースト自身はフォーカスを受けない -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="toast"
        class:is-failure={isFailureToast(toast)}
        role="status"
        out:toastOut|global
        data-toast-id={toast.id}
        onkeydown={(event) => {
          if (event.key === 'Escape' && escapeToast(toast.id)) event.stopPropagation();
        }}
        onmouseenter={() => pauseToast(toast.id)}
        onmouseleave={(event) => {
          // フォーカスがトーストの中にある間は、ポインターが外れても数え直さない（キーボードの人が取り逃さない）
          if (!event.currentTarget.contains(document.activeElement)) resumeToast(toast.id);
        }}
        onfocusin={() => pauseToast(toast.id)}
        onfocusout={(event) => {
          // トーストの中でフォーカスが移るだけなら止めたまま。ポインターが乗ったままなら、その下では数えない
          // （ポインターが外れたとき mouseleave が数え直す）。どちらでもなければ数え直す
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (!event.currentTarget.matches(':hover')) resumeToast(toast.id);
        }}
      >
        {#if toast.icon}<Icon name={toast.icon} />{/if}<span id="toast-message-{toast.id}">{toast.message}</span>
        <!-- 名前が「取り消す: 題」だけでも、フォーカスが着いたときに、消した知らせの本文まで読まれるよう説明に結ぶ -->
        <button
          class="toast-action"
          type="button"
          aria-label={action.ariaLabel}
          aria-describedby={action.ariaLabel === undefined ? undefined : `toast-message-${toast.id}`}
          onclick={(event) =>
            // キーボード由来（detail が 0）でフォーカスがあるときだけ true。マウスで押した人のフォーカスは動かさない
            runToastAction(toast.id, event.detail === 0 && event.currentTarget === document.activeElement)}
          >{action.label}</button
        >
      </div>
    {:else}
      <div class="toast" class:is-failure={isFailureToast(toast)} role="status" out:toastOut|global>
        {#if toast.icon}<Icon name={toast.icon} />{/if}<span>{toast.message}</span>
      </div>
    {/if}
  {/each}
</div>
