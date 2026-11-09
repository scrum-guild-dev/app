<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  // 広い幅では中身を常時表示し、760px 以下だけボタンで開閉する。
  // 開閉はその場の状態だけに持ち、URL・DB へ保存しない。
  let { label, children }: { label: string; children: Snippet } = $props();
  const id = $props.id();
  let open = $state(false);
</script>

<div class="narrow-disclosure" data-open={open}>
  <button
    class="btn is-sm is-quiet narrow-disclosure-toggle"
    type="button"
    aria-expanded={open}
    aria-controls={id}
    onclick={() => (open = !open)}><Icon name="chevron" /><span>{label}</span></button
  >
  <div class="narrow-disclosure-body" {id}>{@render children()}</div>
</div>
