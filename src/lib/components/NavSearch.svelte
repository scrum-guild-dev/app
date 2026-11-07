<script lang="ts">
  import { goto } from '$app/navigation';
  import { t } from '../vocabulary.svelte.ts';
  import { searchOptions, type NavSearchScreen } from '../nav-search.ts';
  import { ariaKeyshortcuts } from '../shortcut-keys.ts';
  import { useShortcut } from '../shortcuts.svelte.ts';
  import Icon from './Icon.svelte';

  // 上の帯の検索（kit.js の nav-search と同じ並び）。画面の名前を絞り、今のワークスペースがあるときは末尾に
  // 「バックログで「…」を探す」の行を足す（選ぶとバックログの ?q= へ移る）。
  // Ctrl+K（Mac は ⌘K）で欄へ移る。開く前にいた場所を覚え、Esc で閉じたらそこへフォーカスを戻す。
  // 作りは ARIA の combobox（aria-activedescendant）。候補の数は常に置く読み上げの領域で伝える。
  // screens の href と backlogHref は呼び出し側が resolve した経路
  let { screens, backlogHref }: { screens: NavSearchScreen[]; backlogHref: string | null } = $props();

  const listId = $props.id();
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  let root = $state<HTMLElement>();
  let opener: HTMLElement | null = null;

  const shortcut = $derived(/Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘ K' : 'Ctrl K');
  const options = $derived(
    searchOptions(
      query,
      screens,
      backlogHref === null
        ? null
        : { href: backlogHref, label: (q) => t('navSearchBacklog', { backlog: t('backlog'), query: q }) },
    ),
  );
  const optionId = (id: string) => `${listId}-${id}`;
  const activeOption = $derived(open ? options[Math.min(active, options.length - 1)] : undefined);
  const status = $derived(
    open ? (options.length === 0 ? t('navSearchEmpty') : t('navSearchCount', { count: options.length })) : '',
  );

  function show(): void {
    open = true;
    active = 0;
  }

  function close(restore: boolean): void {
    open = false;
    query = '';
    if (restore) {
      if (opener && opener.isConnected) opener.focus();
      else input?.blur();
    }
    opener = null;
  }

  async function choose(index: number): Promise<void> {
    const option = options[index];
    if (!option) return;
    close(false);
    input?.blur();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- href は AppShell が resolve した経路に ?q= を足したもの
    await goto(option.href);
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else if (options.length > 0) {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      }
    } else if (event.key === 'Enter') {
      if (open && options.length > 0) {
        event.preventDefault();
        void choose(Math.min(active, options.length - 1));
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  // どの画面からも Ctrl+K / ⌘K で欄へ移る。ダイアログが開いている間は奪わない（shortcuts.svelte.ts の既定）。
  // 欄に文字を打っている間も、ほかの場所と同じく押せる
  const SEARCH_KEYS = 'Mod+K';
  useShortcut(() => ({
    id: 'nav-search',
    keys: SEARCH_KEYS,
    label: () => t('navSearchLabel'),
    inTyping: true,
    global: true,
    hintAnchor: () => root,
    run: () => {
      if (document.activeElement !== input)
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      input?.focus();
      input?.select();
      show();
    },
  }));

  function onFocusout(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (open && root && !(next instanceof Node && root.contains(next))) {
      open = false;
      query = '';
    }
  }
</script>

<div class="nav-search" bind:this={root} onfocusout={onFocusout} role="search" aria-label={t('navSearchLabel')}>
  <Icon name="search" />
  <input
    class="nav-search-input"
    type="text"
    role="combobox"
    autocomplete="off"
    spellcheck="false"
    enterkeyhint="go"
    aria-label={t('navSearchLabel')}
    aria-expanded={open}
    aria-controls={listId}
    aria-autocomplete="list"
    aria-keyshortcuts={ariaKeyshortcuts(SEARCH_KEYS)}
    aria-activedescendant={activeOption ? optionId(activeOption.id) : undefined}
    placeholder={t('navSearchPlaceholder')}
    bind:this={input}
    bind:value={query}
    onfocus={() => {
      if (!open) show();
    }}
    oninput={() => {
      open = true;
      active = 0;
    }}
    onkeydown={onInputKeydown}
  />
  <kbd class="kbd nav-search-key" aria-hidden="true">{shortcut}</kbd>
  <ul class="nav-search-list" id={listId} role="listbox" aria-label={t('navSearchLabel')} hidden={!open}>
    {#each options as option, index (option.id)}
      <!-- eslint-disable-next-line svelte/no-unused-svelte-ignore -- eslint 側は role="option" を対話の要素と見て警告を出さない -->
      <!-- svelte-ignore a11y_click_events_have_key_events -- キーボードの操作は欄（combobox）が受ける -->
      <li
        id={optionId(option.id)}
        role="option"
        aria-selected={index === Math.min(active, options.length - 1)}
        class:is-backlog={option.kind === 'backlog'}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => void choose(index)}
        onmousemove={() => (active = index)}
      >
        {option.label}
      </li>
    {:else}
      <li class="nav-search-empty" role="presentation">{t('navSearchEmpty')}</li>
    {/each}
  </ul>
  <span class="visually-hidden" role="status">{status}</span>
</div>
