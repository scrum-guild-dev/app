<script lang="ts">
  import { tick } from 'svelte';
  import type { IconName } from '../icons.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 見本の行の「⋯」（design/kit.js の rowMenu、components.css の .row-menu）。ボタンを押すと操作の一覧（role="menu"）が開く。
  // 開くと最初の項目へフォーカスを移し、上下の矢印と Home、End で項目を移り、Esc で閉じて「⋯」へ戻る。外を押す、Tab で外へ出る、項目を選ぶと閉じる。
  // 一覧は position: fixed で、押したボタンの右端に合わせて下（収まらなければ上）に開く。引き出しの overflow に切られない。
  // スクロールでは置き直し、幅の変化では閉じる。押せない項目（disabled）は aria-disabled にして、選んでも何も起きない（理由は note に出す）。
  // 項目を選ぶと、押した「⋯」のボタンを onselect に渡す（開いた確認のダイアログが、閉じたときにフォーカスを戻すため）。
  // 引き出しの帯に置くときは、ホバーする行が無いので常に出す（components.css の `.drawer .row-menu-btn`）
  type Item = {
    key: string;
    label: string;
    icon: IconName;
    danger?: boolean;
    disabled?: boolean;
    // 項目の下に添える小さな文（押せない理由など）。読み上げの名前にも含める
    note?: string;
    onselect: (trigger: HTMLElement) => void;
  };
  let { label, items }: { label: string; items: readonly Item[] } = $props();

  const listId = $props.id();
  let open = $state(false);
  let root = $state<HTMLElement>();
  let toggle = $state<HTMLButtonElement>();
  let list = $state<HTMLUListElement>();

  function place(): void {
    if (toggle === undefined || list === undefined) return;
    list.style.maxHeight = `${innerHeight - 16}px`;
    list.style.overflowY = 'auto';
    const rect = toggle.getBoundingClientRect();
    const width = list.offsetWidth;
    const height = list.offsetHeight;
    const gap = 4;
    const left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8));
    const top = rect.bottom + gap + height <= innerHeight ? rect.bottom + gap : Math.max(8, rect.top - gap - height);
    list.style.left = `${left}px`;
    list.style.top = `${top}px`;
  }

  const buttons = (): HTMLButtonElement[] =>
    list ? [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')] : [];

  async function show(): Promise<void> {
    open = true;
    await tick();
    place();
    buttons()[0]?.focus();
  }

  // focus が真なら、「⋯」へフォーカスを戻す（メニューの中にフォーカスがあるときに閉じる場合）
  function close(focus: boolean): void {
    if (!open) return;
    open = false;
    if (focus) toggle?.focus();
  }

  function onToggle(): void {
    if (open) close(false);
    else void show();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (!open) {
      if (event.key === 'ArrowDown' && event.target === toggle) {
        event.preventDefault();
        void show();
      }
      return;
    }
    if (event.key === 'Escape') {
      // 引き出しの Esc（閉じる）に渡さない
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(list?.contains(document.activeElement) ?? false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const all = buttons();
    if (all.length === 0) return;
    event.preventDefault();
    const at = all.indexOf(event.target as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? all.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  }

  function onWindowClick(event: MouseEvent): void {
    if (open && root !== undefined && event.target instanceof Node && !root.contains(event.target)) close(false);
  }

  function select(item: Item): void {
    if (item.disabled === true || toggle === undefined) return;
    const trigger = toggle;
    close(false);
    item.onselect(trigger);
  }

  $effect(() => {
    if (!open) return;
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && list?.contains(event.target)) return;
      place();
    };
    const onResize = (): void => close(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<svelte:window onclick={onWindowClick} />

<!-- キーは中のボタンから届く。外へ出たら閉じる -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="row-menu"
  bind:this={root}
  onkeydown={onKeydown}
  onfocusout={(event) => {
    const next = event.relatedTarget;
    if (open && next instanceof Node && root !== undefined && !root.contains(next)) close(false);
  }}
>
  <button
    class="icon-btn row-menu-btn"
    type="button"
    bind:this={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={listId}
    aria-label={label}
    title={t('rowMenu')}
    onclick={onToggle}
  >
    <Icon name="more" />
  </button>
  <ul
    class="account-menu-list row-menu-list"
    id={listId}
    role="menu"
    aria-label={label}
    bind:this={list}
    hidden={!open}
  >
    {#each items as item (item.key)}
      <li role="none">
        <button
          class="menu-item"
          class:is-danger={item.danger === true}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled === true ? true : undefined}
          onclick={() => select(item)}
        >
          <Icon name={item.icon} /><span>{item.label}</span>
          {#if item.note !== undefined}<span class="props-note">{item.note}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
</span>
