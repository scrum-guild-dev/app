<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の attrChip。行の属性（ポイント、担当）のチップで、押すと値の一覧（行の「⋯」と同じメニューの形。role="menuitemradio"）が開き、
  // 選ぶと onselect を呼ぶ（保存は呼び出し側）。値が無いときは薄い破線（.is-unset）で属性の名前を出す。
  // 開くと、選んでいる項目（無ければ先頭）へフォーカスを移し、上下の矢印、Home、End で移る。Esc で閉じてチップへフォーカスを戻す。
  // 外を押す、Tab、項目を選ぶと閉じる（選んだ後はチップへ戻す）。メニューは position: fixed で押したボタンの右端に合わせ、収まらなければ上に開く。
  // スクロールでは置き直し、幅の変化では閉じる。
  // locked に理由を渡すと押せない（aria-disabled）。理由は見える注記にはせず、読み上げ（aria-describedby）と title で読める。
  // retry を渡すと、メニューの末尾に「もう一度試す」を出す（候補を読めなかったとき）。onopen は開くたびに呼ぶ（候補を読み直すため）。
  type Option = { value: string; text: string };
  let {
    attr,
    text,
    unset = false,
    options,
    current,
    onselect,
    locked,
    onopen,
    retry,
    retrying = false,
    failedNote,
    busy = false,
    lead,
    panel,
    tone,
  }: {
    attr: string;
    text: string;
    unset?: boolean;
    options: readonly Option[];
    current: string;
    onselect: (value: string) => void;
    locked?: string;
    onopen?: () => void;
    retry?: () => void;
    retrying?: boolean;
    failedNote?: string;
    busy?: boolean;
    lead?: Snippet;
    // 渡すと、メニューの代わりに窓（role="dialog"。モーダルにしない）を開き、中にこの内容（期日の日付の欄など）を置く。close で窓を閉じてチップへ戻る
    panel?: Snippet<[() => void]>;
    // 期日の切れ、今日、今週の色（DueChip と同じ .is-danger、.is-warn）
    tone?: 'danger' | 'warn';
  } = $props();

  const ids = $props.id();
  const label = $derived(t('attrChipLabel', { attr, value: unset ? t('attrChipUnset') : text }));
  const reasonId = `${ids}-reason`;
  let open = $state(false);
  let root = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();
  let list = $state<HTMLElement>();

  function items(): HTMLElement[] {
    return list ? [...list.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')] : [];
  }

  // 押したボタンの右端に合わせて下に置く。画面の下に収まらなければ上に置く。高さの上限は画面の高さから余白を引いた値
  function place(): void {
    if (!button || !list) return;
    const margin = 8;
    const rect = button.getBoundingClientRect();
    const width = list.offsetWidth;
    const room = window.innerHeight - 2 * margin;
    list.style.maxHeight = `${room}px`;
    list.style.overflowY = 'auto';
    const height = Math.min(list.scrollHeight, room);
    const below = window.innerHeight - rect.bottom - margin;
    const top = height <= below ? rect.bottom + 4 : Math.max(margin, rect.top - height - 4);
    const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
    list.style.top = `${top}px`;
    list.style.left = `${left}px`;
  }

  async function show(): Promise<void> {
    if (locked !== undefined) return;
    open = true;
    onopen?.();
    await tick();
    place();
    if (panel !== undefined) {
      list?.querySelector<HTMLElement>('input, button')?.focus();
      return;
    }
    const all = items();
    (all.find((item) => item.getAttribute('aria-checked') === 'true') ?? all[0])?.focus();
  }

  function hide(restoreFocus: boolean): void {
    if (!open) return;
    open = false;
    if (restoreFocus) button?.focus();
  }

  function toggle(): void {
    if (open) hide(true);
    else void show();
  }

  function pick(value: string): void {
    hide(true);
    onselect(value);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    // Alt と ↑ ↓ は行の並べ替え（TaskEntry）のキー。メニューの操作に使わず、そのまま行へ通す
    // 開いている間は、行が動いてメニューだけが取り残されないよう、行へも通さない
    if (event.altKey || event.ctrlKey || event.metaKey) {
      if (open) event.stopPropagation();
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown' && event.target === button) {
        event.preventDefault();
        void show();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide(true);
      return;
    }
    // 窓は中の欄とボタンの間を Tab で移れる。外へ出たときは onFocusOut が閉じる
    if (panel !== undefined && event.key === 'Tab') return;
    if (event.key === 'Tab') {
      // 出た先へ移るので戻さない。メニューの中からは、チップへ戻して、そこから Tab を進める
      const inside = list?.contains(event.target as Node) ?? false;
      open = false;
      if (inside) button?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const all = items();
    if (all.length === 0) return;
    event.preventDefault();
    const at = all.indexOf(event.target as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? all.length - 1
          : at < 0
            ? 0
            : (at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  }

  function onFocusOut(event: FocusEvent): void {
    if (panel === undefined || !open) return;
    const next = event.relatedTarget;
    if (next === null || (next instanceof Node && root?.contains(next))) return;
    hide(false);
  }

  function onWindowClick(event: MouseEvent): void {
    if (open && root && event.target instanceof Node && !root.contains(event.target)) hide(false);
  }

  // 外へフォーカスが出た（マウスで別の所を押した場合を含む）は onWindowClick に任せ、ここでは何もしない
  $effect(() => {
    if (!open) return;
    const reposition = (event: Event): void => {
      if (event.target instanceof Node && list?.contains(event.target)) return;
      place();
    };
    // 幅が変わったときだけ閉じる（スマホのアドレスバーの出入りは高さだけが変わる。そのときは置き直す）
    let width = window.innerWidth;
    const close = (): void => {
      if (window.innerWidth !== width) hide(false);
      else place();
      width = window.innerWidth;
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', close);
    };
  });

  // 候補が読み終わるなどで中身が替わったら、置き直す
  $effect(() => {
    void options.length;
    void failedNote;
    void busy;
    if (!open) return;
    void tick().then(() => {
      place();
      // 「もう一度試す」が消えるなどでフォーカスが落ちたら、選んでいる項目（無ければ先頭）へ戻す（Esc で閉じられるように）
      if (open && list && !list.contains(document.activeElement)) {
        const all = items();
        (all.find((item) => item.getAttribute('aria-checked') === 'true') ?? all[0])?.focus();
      }
    });
  });
</script>

<svelte:window onclick={onWindowClick} />

<!-- キーは中のボタンから届く。包む要素そのものはフォーカスを受けない -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="row-menu" bind:this={root} onkeydown={onKeydown} onfocusout={onFocusOut}>
  <!-- アバター（lead）はボタンの外に置く。頭文字が文字として数えられ、見える名前が aria-label を含まなくなるため -->
  {@render lead?.()}
  <button
    class="chip chip-btn"
    class:is-unset={unset}
    class:is-danger={tone === 'danger'}
    class:is-warn={tone === 'warn'}
    type="button"
    bind:this={button}
    aria-haspopup={locked === undefined ? (panel === undefined ? 'menu' : 'dialog') : undefined}
    aria-expanded={locked === undefined ? open : undefined}
    aria-disabled={locked !== undefined ? 'true' : undefined}
    aria-describedby={locked !== undefined ? reasonId : undefined}
    aria-label={label}
    title={locked ?? text}
    onclick={toggle}
  >
    <span class="chip-text">{text}</span>
  </button>
  {#if locked !== undefined}
    <span class="visually-hidden" id={reasonId}>{locked}</span>
  {/if}
  {#if open && panel !== undefined}
    <div
      class="account-menu-list row-menu-list attr-panel"
      role="dialog"
      aria-label={t('attrMenuLabel', { attr })}
      bind:this={list}
    >
      {@render panel(() => hide(true))}
    </div>
  {:else if open}
    <ul
      class="account-menu-list row-menu-list"
      role="menu"
      aria-label={t('attrMenuLabel', { attr })}
      aria-busy={busy}
      bind:this={list}
    >
      {#each options as option (option.value)}
        <li role="none">
          <button
            class="menu-item"
            type="button"
            role="menuitemradio"
            aria-checked={option.value === current}
            onclick={() => pick(option.value)}
          >
            {#if option.value === current}<Icon name="check" />{/if}<span>{option.text}</span>
          </button>
        </li>
      {/each}
      {#if busy && retry === undefined}
        <li role="none">
          <button class="menu-item" type="button" role="menuitem" aria-disabled="true">
            <span>{t('loading')}</span>
          </button>
        </li>
      {/if}
      {#if retry !== undefined}
        <li role="none">
          <button
            class="menu-item"
            type="button"
            role="menuitem"
            aria-disabled={retrying}
            onclick={() => !retrying && retry?.()}
          >
            <span>{failedNote}。{retrying ? t('retrying') : t('retry')}</span>
          </button>
        </li>
      {/if}
    </ul>
  {/if}
</span>
