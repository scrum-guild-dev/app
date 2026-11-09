<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { modalState } from '../toast.svelte.ts';
  import { isWorkspaceId } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  let {
    current,
    slug,
    workspaceId,
    organizationSwitcher,
    menu,
  }: {
    current: string;
    slug: string;
    workspaceId?: string;
    organizationSwitcher?: Snippet;
    menu: Snippet;
  } = $props();

  const menuId = $props.id();
  let dialog: HTMLDialogElement;
  let trigger: HTMLButtonElement;
  let open = $state(false);
  let pressedOutside = false;
  let releasedOutside = false;
  const tabs = $derived([
    { key: 'pageToday', icon: 'sun', href: resolve('/[slug]', { slug }) },
    { key: 'favorites', icon: 'star', href: resolve('/[slug]/favorites', { slug }) },
    ...(isWorkspaceId(workspaceId)
      ? [
          {
            key: 'backlog' as const,
            icon: 'board' as const,
            href: resolve('/[slug]/w/[id]', { slug, id: workspaceId }),
          },
        ]
      : []),
  ] as const);

  function close(): void {
    open = false;
    dialog.close();
    trigger.focus();
  }

  function show(): void {
    dialog.showModal();
    open = true;
  }

  // ショートカットとトーストにも、モーダルが開いていることを伝える。
  $effect(() => {
    if (!open) return;
    untrack(() => modalState.openCount++);
    return () => untrack(() => modalState.openCount--);
  });
  $effect(() => {
    void current;
    void slug;
    untrack(() => {
      if (open) close();
    });
  });
</script>

<div class="mobile-navigation">
  <nav class="mobile-tabs" aria-label={t('mobileTabs')}>
    {#each tabs as tab (tab.key)}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- tabs の href はすべて resolve 済み -->
      <a
        class="mobile-tab"
        href={tab.href}
        aria-label={t(tab.key)}
        aria-current={current === tab.href ? 'page' : undefined}
      >
        <Icon name={tab.icon} />
      </a>
    {/each}
    <button
      class="mobile-tab"
      type="button"
      bind:this={trigger}
      aria-label={t('mobileMenu')}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={menuId}
      onclick={show}
    >
      <span class="mobile-menu-arrows" aria-hidden="true">⌃⌄</span>
    </button>
  </nav>
  <!-- 起票シートの別ストーリーがこの置き場所にボタンを足す。空の操作は出さない。 -->
  <div class="mobile-create-slot"></div>
</div>

<!-- showModal が背景を inert にし、Tab を中に閉じ込める。外で押し始め、離したときだけ閉じる。 -->
<dialog
  class="mobile-menu"
  id={menuId}
  aria-label={t('mobileMenu')}
  bind:this={dialog}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
  onclose={() => {
    if (!dialog.open) {
      open = false;
      trigger.focus();
    }
  }}
  onpointerdown={(event) => {
    pressedOutside = event.target === dialog;
  }}
  onpointerup={(event) => {
    releasedOutside = event.target === dialog;
  }}
  onclick={(event) => {
    const outside = pressedOutside && releasedOutside && event.target === dialog;
    pressedOutside = false;
    releasedOutside = false;
    if (outside || (event.target instanceof Element && event.target.closest('a[href]'))) close();
  }}
>
  <div class="mobile-menu-sheet">
    <div class="mobile-menu-head">
      <h2>{t('menu')}</h2>
      <button class="icon-btn" type="button" aria-label={t('close')} onclick={close}><Icon name="x" /></button>
    </div>
    {@render organizationSwitcher?.()}
    {@render menu()}
  </div>
</dialog>
