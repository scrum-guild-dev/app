<script lang="ts">
  import { ShortcutHints } from '../shortcut-hints.svelte.ts';

  // ⌘（Windows と Linux は Ctrl）を約 0.3 秒押し続けた間だけ、ショートカットのあるものの角にキーを出す（見本は design/kit.js の keyHints）。
  // root のレイアウトに1つだけ置く。画面の上に重ねる層で、押せるものの大きさも並びも動かさず、操作を受けない。
  // 見た目だけなので aria-hidden（読み上げは aria-keyshortcuts）。動かし方と対象の決め方は shortcut-hints.svelte.ts
  const state = new ShortcutHints();
</script>

<svelte:window
  onkeydown={state.keydown}
  onkeyup={state.keyup}
  onblur={state.cancel}
  onresize={state.cancel}
  onpointerdowncapture={state.cancel}
/>
<svelte:document onscrollcapture={state.cancel} />

{#if state.hints.length > 0}
  <div class="key-hints" aria-hidden="true">
    {#each state.hints as hint (hint.id)}
      <kbd class="kbd key-hint" style:left="{hint.left}px" style:top="{hint.top}px">{hint.text}</kbd>
    {/each}
  </div>
{/if}
