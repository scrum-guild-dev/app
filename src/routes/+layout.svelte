<script lang="ts">
  import '@fontsource-variable/noto-sans-jp';
  import '../../design/tokens.css';
  import '../../design/components.css';
  import { onMount, type Snippet } from 'svelte';
  import { prefersReducedMotion } from '../lib/reduced-motion.ts';
  import { navigationLoading, navigationLoadingKind } from '../lib/navigation-loading.svelte.ts';
  import { navigating } from '$app/state';
  import { version } from '$app/env';
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

  const loadingKind = $derived(navigationLoadingKind(navigating.from, navigating.to));
  const loadingShapeTo = $derived(loadingShape(navigating.to?.route.id));
  const slow = $derived(navigationLoading.kind === 'outside');
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
    // 通常は120msの transitionend で外す。描画の遅れに余裕を取り、届かなくても残さない。
    const timer = setTimeout(remove, 400);
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
    const kind = loadingKind;
    // 枠の中で行き先を替えたら、その移動の開始から300msを数え直す。
    // 枠の外では、既存の紙を出したまま行き先の形だけ替える。
    if (kind === 'inside') void navigating.to?.url.pathname;
    return navigationLoading.begin(kind);
  });

  // 待っている間の行き先変更は形だけ替え、表示待ちのタイマーと退場をやり直さない。
  // 到着して行き先が消えた後は、退場中の形を保持する。
  $effect(() => {
    if (slow && loadingKind === 'outside') shownLoadingShape = loadingShapeTo;
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
<div class="visually-hidden" role="status">{navigationLoading.kind !== null ? t('loading') : ''}</div>
{#if slow}
  <div class="loading-overlay" out:loadingOut><LoadingSheet shape={shownLoadingShape} /></div>
{:else}
  {@render children()}
{/if}
<!-- 本番に出ている版を画面で確かめるため、全画面の右下に出す。出すのはこのタブが読み込んだ画面の build の版で、
     API の版（/api/health）とずれたときは版のずれの案内が受け持つ -->
<!-- 要素の末尾の空白はコンパイラが除くため、読み上げの区切りを文字列に含める -->
<p class="app-version"><span class="visually-hidden">{`${t('appVersionLabel')} `}</span>{version}</p>
<ToastRegion />
