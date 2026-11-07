<script lang="ts">
  import { onDestroy, tick, type Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';

  // kit.js の drawerTitleHtml / drawerLinkHtml / drawerBodyHtml の「押すと入力欄に替わる」動きを、自動保存の形にしたもの。
  // view が読む形（値そのものが押せるボタン、または描いた本文）で、押したときに begin を呼ぶと入力欄に替わる。
  // 「保存」「取り消し」のボタンは無い。手を止めて SAVE_DELAY_MS たったか、欄を離れたら save を呼ぶ（閉じるときに待たずに送るため、
  // 部品が外れたときも、まだ送っていない書きかけは送る）。送っている間に書いた分は、送り終えてから最後の値だけを送る。
  // 保存の状態（保存しています、保存しました、保存できませんでした）は欄の横に小さく出し、読み上げの領域（role=status）にも出す。
  // 1行の欄は Enter で今すぐ保存する。Esc は、まだ保存していない書きかけを保存した値に戻す（引き出しは閉じない）。
  // 書きかけが無ければ、1行の欄は読む形に戻り、本文（multiline）は引き出しの閉じる操作に任せる。
  // 読む形は、直している間も DOM に残して隠す（引き出しの名前を指す要素が消えないように）。
  // save はエラーの文（画面に出す）か、成功の null を返す。失敗したら書きかけを欄に残し、欄を離れても自動では送り直さない
  // （「もう一度保存する」か、続きを書いたときに送る）。
  // 書きかけ（ondirty）は、保存に失敗して欄に残っている文か、添付ファイルを上げている途中のもの。
  // 送れる文は、閉じても送るので書きかけに数えない
  let {
    value,
    label,
    labelHidden = false,
    multiline = false,
    markdown,
    inputType = 'text',
    placeholder,
    hint,
    problem,
    save,
    normalize = (raw) => raw,
    ondirty,
    onbegin,
    view,
  }: {
    // 保存した値。空は空の文字
    value: string;
    // 入力欄の名前
    label: string;
    labelHidden?: boolean;
    multiline?: boolean;
    markdown?: { slug: string; workspaceId: string };
    inputType?: 'text' | 'url';
    placeholder?: string;
    hint?: string;
    // 画面の検査。エラーの文か、null
    problem: (raw: string) => string | null;
    save: (raw: string, attachmentIds: string[]) => Promise<string | null>;
    // 保存するときの整え方（前後の空白、空は同じ、など）。書きかけの判定は、整えた値どうしで比べる
    normalize?: (raw: string) => string;
    // 書きかけがあるかが変わるたびに呼ぶ
    ondirty?: (dirty: boolean) => void;
    // 直し始めたときに、そのときの保存した値を渡して呼ぶ（保存で「読んだ値」として使う）
    onbegin?: (started: string) => void;
    view: Snippet<[begin: (event: Event) => void]>;
  } = $props();

  // 手を止めてから保存するまで
  const SAVE_DELAY_MS = 1500;

  const ids = $props.id();
  const inputId = `${ids}-input`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

  let editing = $state(false);
  let draft = $state('');
  let error = $state<string | null>(null);
  let saveState = $state<SaveState>('idle');
  let attachmentIds = $state<string[]>([]);
  let uploading = $state(false);
  let editorInput = $state<HTMLTextAreaElement>();
  let trigger: HTMLElement | null = null;
  let input = $state<HTMLInputElement | HTMLTextAreaElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 送っている最中か（送っている間に書いた分は、送り終えてから最後の値だけ送る）
  let sending = false;
  let destroyed = false;

  const saving = $derived(saveState === 'saving');
  const changed = $derived(normalize(draft) !== normalize(value) || attachmentIds.length > 0);

  $effect(() => {
    ondirty?.(editing && ((error !== null && changed) || uploading));
  });
  // 部品が外れたら（欄が読み取り専用に替わったなど）、書きかけは無くなる
  $effect(() => () => ondirty?.(false));

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  // 部品が外れた（引き出しを閉じた、前後のタスクへ移った）ときに、まだ送っていない文があれば待たずに送る。
  // 結果は save の側が（画面が残っていなければトーストで）知らせる
  onDestroy(() => {
    destroyed = true;
    clearTimer();
    if (editing && !sending && error === null && !uploading && changed && problem(draft) === null) {
      void save(draft, attachmentIds);
    }
  });

  async function begin(event: Event): Promise<void> {
    if (editing) return;
    trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    draft = value;
    attachmentIds = [];
    error = null;
    saveState = 'idle';
    onbegin?.(value);
    editing = true;
    await tick();
    (editorInput ?? input)?.focus();
    // 続きから書けるよう、カーソルを末尾に置く
    (editorInput ?? input)?.setSelectionRange(draft.length, draft.length);
  }

  // 読む形に戻る。focus が真なら、押したボタンへフォーカスを戻す（欄を離れて戻るときは、フォーカスを奪わない）
  async function finish(focus: boolean): Promise<void> {
    clearTimer();
    editing = false;
    error = null;
    saveState = 'idle';
    if (!focus) return;
    await tick();
    trigger?.focus();
  }

  // 送る。送っている間に書いた分は、送り終えてから最後の値だけ送る。失敗したら書きかけを残す
  async function flush(): Promise<void> {
    clearTimer();
    if (sending || destroyed || !editing || uploading || !changed) return;
    const found = problem(draft);
    if (found !== null) {
      error = found;
      saveState = 'failed';
      return;
    }
    sending = true;
    saveState = 'saving';
    let result: string | null;
    let sent: string;
    try {
      for (;;) {
        sent = draft;
        result = await save(sent, attachmentIds);
        if (result !== null || destroyed || normalize(draft) === normalize(sent)) break;
        // 送っている間に書き足された。足された文が検査を通るときだけ、続けて送る
        if (problem(draft) !== null) break;
      }
    } finally {
      sending = false;
    }
    if (destroyed) return;
    if (result !== null) {
      error = result;
      saveState = 'failed';
      return;
    }
    if (normalize(draft) !== normalize(sent)) {
      // 書き足されたが検査を通らなかった。理由を出し、書きかけとして残す
      error = problem(draft);
      saveState = error === null ? 'saved' : 'failed';
      return;
    }
    error = null;
    attachmentIds = [];
    saveState = 'saved';
  }

  function schedule(): void {
    error = null;
    if (saveState === 'failed') saveState = 'idle';
    clearTimer();
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  // 欄を離れた（フォーカスが部品の外へ出た）。待たずに送り、送れたら読む形に戻る。失敗したら入力欄を残す。
  // 前に失敗している文は、自動では送り直さない（入力欄を残す）
  async function onfocusout(event: FocusEvent): Promise<void> {
    const next = event.relatedTarget;
    if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return;
    if (!editing) return;
    if (error === null) await flush();
    if (destroyed || !editing) return;
    if (error === null && !uploading && !changed && !sending) await finish(false);
  }

  // 保存した値に戻す
  function revert(): void {
    clearTimer();
    draft = value;
    attachmentIds = [];
    error = null;
    saveState = 'idle';
  }

  // 1行の欄の Enter と Esc。変換中（keyCode 229 は、isComposing が偽になる確定直後も含む）の Enter は変換の確定、Esc は変換の取り消しなので、
  // 送らず、戻さない
  async function onkeydown(event: KeyboardEvent): Promise<void> {
    if (event.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      // まだ保存していない書きかけは、保存した値に戻す。引き出しは閉じない
      if (changed || error !== null) {
        event.preventDefault();
        event.stopPropagation();
        revert();
        return;
      }
      if (!multiline) {
        event.preventDefault();
        event.stopPropagation();
        await finish(true);
      }
      return;
    }
    if (event.key === 'Enter' && !multiline) {
      event.preventDefault();
      if (error === null) await flush();
      if (error === null && !changed) await finish(true);
    }
  }

  async function retry(): Promise<void> {
    if (saving) return;
    error = null;
    await flush();
    (editorInput ?? input)?.focus();
  }

  const statusText = $derived(
    saveState === 'saving'
      ? t('taskSaving')
      : saveState === 'saved'
        ? t('taskSaved')
        : saveState === 'failed'
          ? t('taskSaveFailed')
          : '',
  );
</script>

<div class="edit-view" hidden={editing}>{@render view(begin)}</div>
{#if editing}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="edit-form" role="group" aria-label={label} {onfocusout} onkeydown={multiline ? onkeydown : undefined}>
    <div class="field" class:is-invalid={error !== null}>
      <div class="field-head">
        <label class="field-label" class:visually-hidden={labelHidden} for={inputId}>{label}</label>
        {#if saveState !== 'idle'}
          <span class="save-state is-{saveState}" aria-hidden="true">
            <Icon name={saveState === 'failed' ? 'alert' : saveState === 'saved' ? 'check' : 'clock'} />{statusText}
          </span>
        {/if}
      </div>
      {#if multiline && markdown !== undefined}
        <MarkdownEditor
          {...markdown}
          id={inputId}
          bind:input={editorInput}
          bind:value={draft}
          bind:attachmentIds
          bind:uploading
          oninput={schedule}
          {placeholder}
          invalid={error !== null}
          describedby={[hint !== undefined ? hintId : null, error !== null ? errorId : null]
            .filter((id) => id !== null)
            .join(' ') || undefined}
        />
      {:else if multiline}
        <textarea
          class="textarea"
          id={inputId}
          bind:this={input}
          bind:value={draft}
          oninput={schedule}
          {placeholder}
          aria-invalid={error !== null}
          aria-describedby={[hint !== undefined ? hintId : null, error !== null ? errorId : null]
            .filter((id) => id !== null)
            .join(' ') || undefined}></textarea>
      {:else}
        <input
          class="input"
          id={inputId}
          type={inputType}
          bind:this={input}
          bind:value={draft}
          oninput={schedule}
          {onkeydown}
          {placeholder}
          autocomplete="off"
          aria-invalid={error !== null}
          aria-describedby={[hint !== undefined ? hintId : null, error !== null ? errorId : null]
            .filter((id) => id !== null)
            .join(' ') || undefined}
        />
      {/if}
      {#if hint !== undefined}<span class="field-hint" id={hintId}>{hint}</span>{/if}
      {#if error !== null}
        <span class="field-error" id={errorId} role="alert"><Icon name="alert" />{error}</span>
        <button class="btn is-sm is-quiet" type="button" aria-disabled={saving} onclick={retry}>{t('editRetry')}</button
        >
      {/if}
    </div>
    <span class="visually-hidden" role="status">{statusText}</span>
  </div>
{/if}
