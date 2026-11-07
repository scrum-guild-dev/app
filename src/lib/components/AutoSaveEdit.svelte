<script lang="ts">
  import { onDestroy, tick, untrack, type Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import { showToast } from '../toast.svelte.ts';
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
  // 部品の中を押している最中か（押した先がフォーカスを受けないとき、focusout の relatedTarget が空になる）
  let pressedInside = false;
  // 保存に失敗したときの文（これと違う文になったら、新しい文として自動で送る）
  let failedDraft = '';

  const saving = $derived(saveState === 'saving');
  // 破棄された後（onDestroy、送り終えた後）にも読むので、$derived にしない
  const hasChanges = () => normalize(draft) !== normalize(value) || attachmentIds.length > 0;

  $effect(() => {
    // 送れる文は閉じても送るので数えない。送れない文（検査に落ちる、失敗した）と、上げている途中の添付ファイルは、確かめる
    ondirty?.(editing && (((error !== null || problem(draft) !== null) && hasChanges()) || uploading));
  });
  // ファイルを足したときは、入力の操作を通らずに本文が変わる（画像の差し込み）。フォーカスが入力欄に無くても、手を止めたら送る
  $effect(() => {
    const added = attachmentIds.length;
    untrack(() => {
      if (editing && added > 0) schedule();
    });
  });
  // 部品が外れたら（欄が読み取り専用に替わったなど）、書きかけは無くなる
  $effect(() => () => ondirty?.(false));

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  // 部品が外れた（引き出しを閉じた、前後のタスクへ移った）ときに、まだ送っていない文があれば待たずに送る。
  // 結果は save の側が（画面が残っていなければトーストで）知らせる
  // 送っている最中に外れたときは、送り終えた後の flush が、書き足された分を最後に送る
  onDestroy(() => {
    destroyed = true;
    clearTimer();
    if (editing && !sending && error === null && !uploading && hasChanges() && problem(draft) === null) {
      sendAfterClose(draft, attachmentIds);
    }
  });

  // 外れた後の送信。入力欄はもう無いので、失敗は書いた分が残っていると言わず、トーストで知らせる
  function sendAfterClose(raw: string, ids: string[]): void {
    void save(raw, ids)
      .then((result) => {
        if (result !== null) showToast(result, 'alert');
      })
      .catch(() => showToast(t('taskSaveFailed'), 'alert'));
  }

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
    // 保存できた印は、読む形に戻った後も残す（次に書き始めたときに消す）
    if (saveState !== 'saved') saveState = 'idle';
    if (!focus) return;
    await tick();
    trigger?.focus();
  }

  // 送る。送っている間に書いた分は、送り終えてから最後の値だけ送る。失敗したら書きかけを残す
  async function flush(): Promise<void> {
    clearTimer();
    if (sending || destroyed || !editing || uploading || !hasChanges()) return;
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
        if (result !== null) break;
        // 保存できた添付ファイルは、続けて送るときに送り直さない
        attachmentIds = [];
        if (destroyed || normalize(draft) === normalize(sent)) break;
        // 送っている間に書き足された。足された文が検査を通るときだけ、続けて送る
        if (problem(draft) !== null) break;
      }
    } catch {
      sent = draft;
      result = t('taskSaveFailed');
    } finally {
      sending = false;
    }
    if (destroyed) {
      // 送っている間に外れた。書き足された分があり、検査を通るなら、最後に送る
      if (result === null && normalize(draft) !== normalize(sent) && problem(draft) === null) {
        sendAfterClose(draft, []);
      }
      return;
    }
    if (result !== null) {
      error = result;
      failedDraft = draft;
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
    // 中を押してフォーカスが行き先なしになった（ラベル、ヒント、ドロップ領域。Safari のボタン）か、別の窓へ移った
    // （ファイルを選ぶ OS のダイアログを含む）ときは、離れたと数えない
    if (next === null && (pressedInside || !document.hasFocus())) {
      pressedInside = false;
      return;
    }
    if (!editing) return;
    // 失敗した後に本文が変わっていたら（ファイルの追加など、入力の操作を通らない変更を含む）、新しい文として送る
    if (error === null || draft !== failedDraft) {
      error = null;
      await flush();
    }
    if (destroyed || !editing) return;
    if (error === null && !uploading && !hasChanges() && !sending) await finish(false);
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
      if (hasChanges() || error !== null) {
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
      if (error === null && !hasChanges()) await finish(true);
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
  // 読み上げの領域に出すのは、保存しています／保存しました。失敗は理由を role="alert" が読むので、二重にしない
  const liveText = $derived(saveState === 'failed' ? '' : statusText);
</script>

<div class="edit-view" hidden={editing}>{@render view(begin)}</div>
{#if editing}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="edit-form"
    role="group"
    aria-label={label}
    {onfocusout}
    onpointerdown={() => {
      // フォーカスの移りは押した直後の同じ流れで起きるので、そのときだけ数える
      pressedInside = true;
      setTimeout(() => (pressedInside = false), 0);
    }}
    onkeydown={multiline ? onkeydown : undefined}
  >
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
  </div>
{/if}
<!-- 保存の状態の読み上げ。読む形に戻った後も、保存できたことを残す -->
<span class="visually-hidden" role="status">{liveText}</span>
{#if !editing && saveState === 'saved'}
  <span class="save-state is-saved" aria-hidden="true"><Icon name="check" />{statusText}</span>
{/if}
