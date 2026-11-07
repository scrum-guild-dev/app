<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // バックログの木の空の行（見本は design/kit.js の treeAdd）。題を打って Enter で作る。エピックの末尾、木の末尾に置く。
  // 何を作る行かは、見えるラベル（label）で示す。読み上げの名前（name）は、親の題を添えて同じ名前の行を区別する。
  // create は作る処理で、エラーの文（画面に出す）か、成功の null を返す。成功したら入力を空に戻し、フォーカスを残して続けて打てる。
  // 日本語の変換中の Enter は確定なので作らず、変換中の Esc は変換の取り消しなので素通しする（Safari は確定の Enter の前に compositionend を出すので、keyCode 229 も見る）。
  // 変換中でない Esc は書きかけを捨てる（フォーカスは欄に残す。preventDefault するので、引き出しは閉じない）。
  // 空のまま Enter を押しても、離れても、何も送らない。書きかけで離れたときは、書きかけを残す（自動では作らない）。
  // 送っている間は欄を readonly にしてフォーカスを残し、読み上げの領域に「作っています」を出す。
  let {
    label,
    name = label,
    placeholder,
    problem,
    create,
    level = 'story',
  }: {
    // 行に見える文（「<ストーリー>を足す」など）
    label: string;
    // 読み上げの名前。省けば label
    name?: string;
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
    // 変換中のキーは、ここで扱わない（Safari は確定の Enter で isComposing が偽、keyCode が 229 になる）
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // 送っている間は捨てられない（送信は止まらないので、捨てたつもりで作られるのを避ける）
      if (sending) return;
      value = '';
      error = null;
    }
  }
</script>

<div class="tree-add is-{level}">
  <span class="tree-add-mark" aria-hidden="true"><Icon name="plus" /></span>
  <label class="tree-add-label" for={inputId}>{label}</label>
  <input
    id={inputId}
    aria-label={name}
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
    enterkeyhint="done"
    onkeydown={keydown}
  />
  <span class="visually-hidden" role="status">{sending ? t('treeAddSending') : ''}</span>
  {#if error !== null}
    <p class="tree-add-error" id={errorId} role="alert">{error}</p>
  {/if}
</div>
