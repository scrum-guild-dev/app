<script lang="ts">
  import '@fontsource/noto-sans-jp/400.css';
  import '@fontsource/noto-sans-jp/500.css';
  import '@fontsource/noto-sans-jp/600.css';
  import '@fontsource/noto-sans-jp/700.css';
  import '@fontsource/noto-sans-jp/900.css';
  import '../../design/tokens.css';
  import '../../design/components.css';
  import { onMount, untrack, type Snippet } from 'svelte';
  import { prefersReducedMotion } from '../lib/reduced-motion.ts';
  import { navigating } from '$app/state';
  import ArtSprite from '../lib/components/ArtSprite.svelte';
  import IconSprite from '../lib/components/IconSprite.svelte';
  import LoadingSheet from '../lib/components/LoadingSheet.svelte';
  import ShortcutHelp from '../lib/components/ShortcutHelp.svelte';
  import ShortcutHints from '../lib/components/ShortcutHints.svelte';
  import ToastRegion from '../lib/components/ToastRegion.svelte';
  import { loadingShape, type LoadingShape } from '../lib/loading-shape.ts';
  import { shortcuts } from '../lib/shortcuts.svelte.ts';
  import { t } from '../lib/vocabulary.svelte.ts';

  let { children }: { children: Snippet } = $props();

  // 枠の外の画面（組織の選択、見つからない、運用）から移る間は、読み込み中の表示を出す。
  // 組織の枠の中から移る間は、今の画面を残す（枠ごと消さない）。
  // 短い読み込みでは出さないよう、移り始めから SLOW_MS たっても終わらないときだけ出す
  const SLOW_MS = 300;
  const loadingFromOutside = $derived(navigating.to !== null && !navigating.from?.route.id?.startsWith('/[slug]'));
  // 行き先が組織の枠の中なら、読み込み中も枠と行き先の本文の組みに近い形で出す（読み込んだ後に組みと位置が変わらないように）
  const loadingShapeTo = $derived(loadingShape(navigating.to?.route.id));
  let slow = $state(false);
  // 行き先の情報は到着時に消える。退場中に枠を紙へ替えないよう、表示した形を保持する。
  let shownLoadingShape = $state<LoadingShape | null>(null);

  // URL を直接開いた最初の読み込みの表示（src/app.html の #boot-loading）は、画面が描かれたら要らない
  // （骨組みの形の印 data-boot と data-boot-nav も、以後の画面の開閉と食い違わないよう外す）
  onMount(() => {
    const boot = document.getElementById('boot-loading');
    const removeBoot = () => {
      boot?.remove();
      delete document.documentElement.dataset.boot;
      delete document.documentElement.dataset.bootNav;
    };
    if (!boot) {
      removeBoot();
      return;
    }
    // 300ms より前に終わったときは、隠れたまま取り除く。
    if (prefersReducedMotion() || getComputedStyle(boot).visibility !== 'visible') {
      removeBoot();
      return;
    }
    const remove = () => {
      clearTimeout(timer);
      boot.removeEventListener('transitionend', ended);
      removeBoot();
    };
    const ended = (event: TransitionEvent) => {
      if (event.target === boot && event.propertyName === 'opacity') remove();
    };
    boot.inert = true;
    boot.setAttribute('aria-hidden', 'true');
    boot.addEventListener('transitionend', ended);
    // タブの非表示などで transitionend が届かなくても残さない。
    const timer = setTimeout(remove, 200);
    boot.classList.add('is-leaving');
    return remove;
  });

  function loadingOut(node: HTMLElement) {
    if (prefersReducedMotion()) return { duration: 0 };
    // クラスを付ける前に opacity: 1 の状態を確定し、CSS の transition を開始する。
    const fast = parseFloat(getComputedStyle(node).getPropertyValue('--duration-fast'));
    node.classList.add('is-leaving');
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
    // Svelte は退場中の DOM の保持だけを受け持つ。動きは共通 CSS のトークンで揃える。
    return {
      duration: Number.isFinite(fast) ? fast : 120,
    };
  }

  $effect(() => {
    if (!loadingFromOutside) return;
    const timer = setTimeout(() => {
      shownLoadingShape = untrack(() => loadingShapeTo);
      slow = true;
    }, SLOW_MS);
    return () => {
      clearTimeout(timer);
      slow = false;
    };
  });

  // 待っている間の行き先変更は形だけ替え、表示待ちのタイマーと退場をやり直さない。
  // 到着して行き先が消えた後は、退場中の形を保持する。
  $effect(() => {
    if (slow && loadingFromOutside) shownLoadingShape = loadingShapeTo;
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
  <div class="loading-overlay" out:loadingOut><LoadingSheet shape={shownLoadingShape} /></div>
{:else}
  {@render children()}
{/if}
<ToastRegion />
