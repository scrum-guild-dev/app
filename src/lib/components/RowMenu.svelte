<script lang="ts" module>
  import type { IconName } from '../icons.ts';

  export interface RowMenuItem {
    key: string;
    label: string;
    icon: IconName;
    // 端で動かせないなど。フォーカスを失わないよう disabled でなく aria-disabled にし、押しても何もしない
    disabled?: boolean;
    // 押した項目。trigger は「⋯」のボタン（ダイアログを閉じたときのフォーカスの戻り先）
    onselect: (trigger: HTMLButtonElement) => void;
  }
</script>

<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の rowMenu。行の完了の丸のほかの操作をまとめる「⋯」。広い幅ではホバーと行の中のフォーカスで出し（CSS。opacity だけ）、
  // 760px 以下と pointer: coarse では常に出す。メニューは role="menu"。開くと最初の項目へフォーカスを移し、上下の矢印、Home、End で
  // 項目を移り、Esc で閉じて「⋯」へ戻る。外を押す、Tab、項目を選ぶと閉じる。一覧は position: fixed で、押したボタンの右端に合わせて
  // 下（収まらなければ上）に開く。幅の変化で閉じ、スクロールでは置き直す。
  let { title, items }: { title: string; items: readonly RowMenuItem[] } = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();
  let list = $state<HTMLUListElement>();
  const label = $derived(t('rowMenuLabel', { title }));

  export function focus(): void {
    button?.focus();
  }

  function itemButtons(): HTMLButtonElement[] {
    return list ? [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')] : [];
  }

  function place(): void {
    if (!button || !list) return;
    list.style.maxHeight = `${innerHeight - 16}px`;
    list.style.overflowY = 'auto';
    const r = button.getBoundingClientRect();
    const w = list.offsetWidth;
    const h = list.offsetHeight;
    const gap = 4;
    const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
    const top = r.bottom + gap + h <= innerHeight ? r.bottom + gap : Math.max(8, r.top - gap - h);
    list.style.left = `${left}px`;
    list.style.top = `${top}px`;
  }

  function close(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    if (returnFocus) button?.focus();
  }

  function toggle(): void {
    if (open) {
      close(false);
      return;
    }
    open = true;
    // 描画の後に置いて、最初の項目へフォーカスを移す
    queueMicrotask(() => {
      place();
      itemButtons()[0]?.focus();
    });
  }

  function select(item: RowMenuItem): void {
    if (item.disabled === true || button === undefined) return;
    const trigger = button;
    close(true);
    item.onselect(trigger);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (!open) {
      if (event.key === 'ArrowDown' && event.target === button && !event.altKey) {
        event.preventDefault();
        toggle();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      // 出た先へ移るので、フォーカスは戻さない（メニューの中からは「⋯」へ戻してから普通に移る）
      close(list?.contains(event.target as Node) === true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey) return;
    if (!list?.contains(event.target as Node)) return;
    const buttons = itemButtons();
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  }

  function onClick(event: MouseEvent): void {
    if (open && root && event.target instanceof Node && !root.contains(event.target)) open = false;
  }

  function onScroll(event: Event): void {
    if (open && !(event.target instanceof Node && list?.contains(event.target))) place();
  }
</script>

<svelte:window onclick={onClick} onresize={() => close(false)} onscrollcapture={onScroll} />

<!-- キーは中のボタンから届く -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="row-menu" bind:this={root} onkeydown={onKeydown}>
  <button
    class="icon-btn row-menu-btn"
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={t('rowMenuTitle')}
    bind:this={button}
    onclick={toggle}><Icon name="more" /></button
  >
  <ul class="account-menu-list row-menu-list" role="menu" aria-label={label} hidden={!open} bind:this={list}>
    {#each items as item (item.key)}
      <li role="none">
        <button
          class="menu-item"
          type="button"
          role="menuitem"
          aria-disabled={item.disabled === true ? true : undefined}
          onclick={() => select(item)}><Icon name={item.icon} /><span>{item.label}</span></button
        >
      </li>
    {/each}
  </ul>
</span>
