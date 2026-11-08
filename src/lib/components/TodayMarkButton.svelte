<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  let {
    title,
    marked,
    disabled = false,
    describedby,
    onclick,
  }: {
    title: string;
    marked: boolean;
    disabled?: boolean;
    describedby?: string;
    onclick: () => void;
  } = $props();
</script>

<button
  class="sun"
  type="button"
  aria-pressed={marked}
  aria-label={t('todayMarkLabel', { mark: t('todayMark'), title })}
  title={t('todayMark')}
  aria-disabled={disabled}
  aria-describedby={describedby}
  onclick={() => {
    if (!disabled) onclick();
  }}><Icon name="sun" /></button
>
