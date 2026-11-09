<script lang="ts">
  import '@fontsource/noto-sans-jp/400.css';
  import '@fontsource/noto-sans-jp/500.css';
  import '@fontsource/noto-sans-jp/600.css';
  import '@fontsource/noto-sans-jp/700.css';
  import '@fontsource/noto-sans-jp/900.css';
  import '../../design/tokens.css';
  import '../../design/components.css';
  import { onMount, type Snippet } from 'svelte';
  import { navigating } from '$app/state';
  import ArtSprite from '../lib/components/ArtSprite.svelte';
  import IconSprite from '../lib/components/IconSprite.svelte';
  import LoadingSheet from '../lib/components/LoadingSheet.svelte';
  import ShortcutHelp from '../lib/components/ShortcutHelp.svelte';
  import ShortcutHints from '../lib/components/ShortcutHints.svelte';
  import ToastRegion from '../lib/components/ToastRegion.svelte';
  import { shortcuts } from '../lib/shortcuts.svelte.ts';
  import { t } from '../lib/vocabulary.svelte.ts';

  let { children }: { children: Snippet } = $props();

  // 枠の外の画面（組織の選択、見つからない、運用）から移る間は、読み込み中の表示を出す。
  // 組織の枠の中から移る間は、今の画面を残す（枠ごと消さない）。
  // 短い読み込みでは出さないよう、移り始めから SLOW_MS たっても終わらないときだけ出す
  const SLOW_MS = 300;
  const loadingFromOutside = $derived(navigating.to !== null && !navigating.from?.route.id?.startsWith('/[slug]'));
  let slow = $state(false);

  // URL を直接開いた最初の読み込みの表示（src/app.html の #boot-loading）は、画面が描かれたら要らない
  onMount(() => document.getElementById('boot-loading')?.remove());

  $effect(() => {
    if (!loadingFromOutside) return;
    const timer = setTimeout(() => (slow = true), SLOW_MS);
    return () => {
      clearTimeout(timer);
      slow = false;
    };
  });
</script>

<!-- キーボードのショートカットは、ここで keydown を1つだけ受けて shortcuts.svelte.ts が振り分ける。
     bfcache から戻った画面（ログアウトの前の組織の画面など）は、メモリに残った前の人のデータと busy のまま止まった状態ごと戻る。
     読み直して、今のセッションで作り直す -->
<svelte:window onpageshow={(event) => event.persisted && location.reload()} onkeydown={shortcuts.handle} />

<!-- 全画面に共通のものだけを置く。左のメニューと上の帯の枠は /[slug] のレイアウト（ログインと組織の選択には枠を出さない） -->
<IconSprite />
<ShortcutHints />
<ShortcutHelp />
<ArtSprite />
<!-- 読み込み中を読み上げに伝える。領域は常に置き、中の文字だけを替える -->
<div class="visually-hidden" role="status">{slow ? t('loading') : ''}</div>
{#if slow}
  <LoadingSheet />
{:else}
  {@render children()}
{/if}
<ToastRegion />
