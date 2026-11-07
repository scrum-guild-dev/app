<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の treeAdd（バックログの木の空の行）。題を打って Enter で作る。エピックの末尾、木の末尾に置く。
  // create は作る処理で、エラーの文（画面に出す）か、成功の null を返す。成功したら入力を空に戻し、フォーカスを残して続けて打てる。
  // 日本語の変換中の Enter は確定なので作らない。Esc は書きかけを捨てて外へ出る（Esc は preventDefault するので、引き出しは閉じない）。
  // 空のまま Enter を押しても、離れても、何も送らない。書きかけで離れたときは、書きかけを残す（自動では作らない）。
  // 送っている間は欄を readonly にしてフォーカスを残し、読み上げの領域に「作っています」を出す。
  let {
    label,
    placeholder,
    problem,
    create,
    level = 'story',
  }: {
    // 欄の名前（「<ストーリー>を足す」など）
    label: string;
    placeholder: string;
    // 画面の検査。エラーの文か、null
    problem: (title: string) => string | null;
    create: (title: string) => Promise<string | null>;
    // 字下げの段。epic は木の最上段、story はエピックの配下
    level?: 'epic' | 'story';
  } = $props();

  const ids = $props.id();
  const inputId = `${ids}-input`;
  const errorId = `${ids}-error`;

  let value = $state('');
  let error = $state<string | null>(null);
  let sending = $state(false);
  let composing = false;
  let input = $state<HTMLInputElement>();

  async function submit(): Promise<void> {
    if (sending) return;
    const title = value.trim();
    if (title === '') return;
    const found = problem(title);
    if (found !== null) {
      error = found;
      return;
    }
    error = null;
    sending = true;
    try {
      const failed = await create(title);
      if (failed === null) {
        value = '';
      } else {
        error = failed;
      }
    } finally {
      sending = false;
      await tick();
      input?.focus();
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      if (composing || event.isComposing) return;
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      value = '';
      error = null;
      input?.blur();
    }
  }
</script>

<div class="tree-add is-{level}">
  <span class="tree-add-mark" aria-hidden="true"><Icon name="plus" /></span>
  <label class="visually-hidden" for={inputId}>{label}</label>
  <input
    id={inputId}
    bind:this={input}
    bind:value
    class="tree-add-input"
    type="text"
    autocomplete="off"
    {placeholder}
    readonly={sending}
    aria-invalid={error !== null}
    aria-describedby={error === null ? undefined : errorId}
    oninput={() => (error = null)}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
    onkeydown={keydown}
  />
  <span class="visually-hidden" role="status">{sending ? t('treeAddSending') : ''}</span>
  {#if error !== null}
    <p class="tree-add-error" id={errorId} role="alert">{error}</p>
  {/if}
</div>
