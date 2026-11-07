<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { hintText, isMacPlatform } from '../shortcut-keys.ts';
  import { shortcutHelpGroups } from '../shortcut-help.ts';
  import { shortcuts, useShortcut, type Shortcut } from '../shortcuts.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';

  // `?` で、今の画面で使えるショートカットの一覧をダイアログで出す（見本は design/kit.js の DIALOGS.shortcutHelp）。
  // 一覧は登録（shortcuts.svelte.ts の items）から作り、キーも名前も二重に書かない。root のレイアウトに1つだけ置く。
  // 入力欄の中、別のダイアログが開いている間は、登録の既定で働かない（`?` はそのまま文字になる）。閉じたらフォーカスは開く前の場所へ戻る（Dialog）
  const HELP_KEYS = '?';
  let open = $state(false);
  // 開いた時点の登録。開いている間に画面が替わっても、見せている一覧は動かさない
  let groups = $state.raw<{ screen: Shortcut[]; global: Shortcut[] }>({ screen: [], global: [] });
  const mac = isMacPlatform();

  // 開いている間に画面が替わったら（ブラウザの「戻る」など）閉じる。前の画面のキーを見せ続けない
  $effect(() => {
    void page.url.pathname;
    untrack(() => (open = false));
  });

  useShortcut(() => ({
    id: 'shortcut-help',
    keys: HELP_KEYS,
    label: () => t('shortcutHelp'),
    global: true,
    helpOrder: 9,
    run: () => {
      groups = shortcutHelpGroups(shortcuts.items);
      open = true;
    },
  }));
</script>

{#snippet group(id: string, title: string, list: Shortcut[])}
  {#if list.length > 0}
    <section class="shortcut-group" aria-labelledby="shortcut-help-{id}">
      <h3 class="shortcut-group-title" id="shortcut-help-{id}">{title}</h3>
      <dl class="shortcut-list">
        {#each list as shortcut (shortcut.id)}
          <div class="shortcut-row">
            <dt>{shortcut.label()}</dt>
            <dd><kbd class="kbd">{hintText(shortcut.keys, mac)}</kbd></dd>
          </div>
        {/each}
      </dl>
    </section>
  {/if}
{/snippet}

<Dialog bind:open title={t('shortcutHelp')}>
  {@render group('screen', t('shortcutHelpScreen'), groups.screen)}
  {@render group('global', t('shortcutHelpGlobal'), groups.global)}
</Dialog>
