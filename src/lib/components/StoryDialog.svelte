<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { storyCreate } from '../../shared/operations/story/index.ts';
  import {
    LINK_URL_MAX_LENGTH,
    STORY_TEXT_MAX_LENGTH,
    STORY_TITLE_MAX_LENGTH,
    canonicalLinkUrl,
    linkUrlProblem,
    longTextProblem,
    normalizeLinkUrl,
    normalizeLongText,
    storyTitleProblem,
    type StoryTitleProblem,
  } from '../../shared/story.ts';
  import type { DefinitionRef } from '../../shared/operations/definition/definition.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // ストーリーを作るダイアログ（見出しの「<ストーリー>を作る」から開く）。欄はタイトル、受け入れ基準、本文、期日、リンクと区分で、
  // タイトル以外は空でよい。ストーリーを直すのは、木の題から開く引き出し（StoryDrawer）。
  // 送っている間の扱いと、古い応答を捨てる generation は TaskCreateDialog と同じ。
  // 作れたら閉じて、画面が木を読み直す（onsaved）。本文と受け入れ基準は、この版では文字のまま持つ。
  // 区分（categories から選ぶ）は、親のないストーリーが持つ（作るストーリーは親を持たない）。
  // 閉じたワークスペースでは、開く口を出さない。開いている間に閉じられたときは、理由を出し、閉じたときに画面を読み直す
  let {
    slug,
    workspaceId,
    categories,
    categoriesFailed,
    onsaved,
    announceCreated = true,
  }: {
    slug: string;
    workspaceId: string;
    categories: readonly DefinitionRef[];
    // 区分の一覧を読めなかった（選択肢は区分なしだけ）
    categoriesFailed: boolean;
    // 作ったストーリーの ID（画面が、作ったものが絞り込みに当たるかを確かめる）
    onsaved: (createdId: string) => void;
    // 偽なら作った知らせ（トースト）を出さない。絞り込み中の画面が、作ったものが当たるかを確かめてから自分で知らせる
    announceCreated?: boolean;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const fieldIds = {
    title: `${ids}-title`,
    acceptance: `${ids}-acceptance`,
    body: `${ids}-body`,
    due: `${ids}-due`,
    link: `${ids}-link`,
  } as const;
  const categoryId = `${ids}-category`;

  type FieldName = keyof typeof fieldIds;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();
  let dueInput = $state<HTMLInputElement>();

  let title = $state('');
  let acceptance = $state('');
  let body = $state('');
  let dueOn = $state('');
  let link = $state('');
  // 選んだ区分の ID。空は区分なし
  let category = $state('');
  let errors = $state<Partial<Record<FieldName, string>>>({});
  let submitError = $state<string | null>(null);
  let submitting = $state(false);

  // 開き直しと部品の取り外しで進める。古い応答が、今の状態を上書きしない
  let generation = 0;

  // 閉じたと分かったら、ダイアログを閉じたときに画面を読み直す（すぐ読み直すと理由の文を読めなくなる）
  let reloadOnClose = false;
  $effect(() => {
    if (open || !reloadOnClose) return;
    reloadOnClose = false;
    void invalidateAll();
  });

  const currentWorkspaceId = $derived(workspaceId);
  $effect(() => {
    void currentWorkspaceId;
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(trigger?: HTMLElement | null): void {
    generation++;
    reloadOnClose = false;
    title = '';
    acceptance = '';
    body = '';
    dueOn = '';
    link = '';
    category = '';
    errors = {};
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
  }

  const titleMessages = $derived<Record<StoryTitleProblem, string>>({
    required: t('storyTitleRequired'),
    too_long: t('storyTitleTooLong', { max: STORY_TITLE_MAX_LENGTH }),
    invalid_character: t('storyTitleInvalidCharacter'),
  });

  function textProblemMessage(raw: string, field: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field, max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field });
    return null;
  }

  function linkProblemMessage(raw: string): string | null {
    const value = normalizeLinkUrl(raw);
    const problem = value === null ? null : linkUrlProblem(value);
    if (problem === 'too_long') return t('linkTooLong', { max: LINK_URL_MAX_LENGTH });
    if (problem === 'invalid_url') return t('linkInvalid');
    return null;
  }

  // 検査の結果。先頭のエラーの欄へフォーカスを移すため、画面の上から順に並べる
  function validate(): Partial<Record<FieldName, string>> {
    const found: Partial<Record<FieldName, string>> = {};
    const titleProblem = storyTitleProblem(title.trim());
    if (titleProblem !== null) found.title = titleMessages[titleProblem];
    const acceptanceMessage = textProblemMessage(acceptance, t('ac'));
    if (acceptanceMessage !== null) found.acceptance = acceptanceMessage;
    const bodyMessage = textProblemMessage(body, t('fieldBody'));
    if (bodyMessage !== null) found.body = bodyMessage;
    // 日付の入力は、途中までしか打たれていない値や存在しない日付だと、value が空になり、validity.badInput が立つ
    if (dueInput?.validity.badInput) found.due = t('dueInvalid', { due: t('due') });
    const linkMessage = linkProblemMessage(link);
    if (linkMessage !== null) found.link = linkMessage;
    return found;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    errors = validate();
    const firstInvalid = (Object.keys(fieldIds) as FieldName[]).find((name) => errors[name] !== undefined);
    if (firstInvalid !== undefined) {
      document.getElementById(fieldIds[firstInvalid])?.focus();
      return;
    }
    const fields = {
      title: title.trim(),
      acceptance_criteria_md: normalizeLongText(acceptance),
      body_md: normalizeLongText(body),
      due_on: dueOn === '' ? null : dueOn,
      link_url: normalizeLinkUrl(link),
      category_id: category === '' ? null : category,
    };

    const mine = generation;
    submitting = true;
    submitError = null;
    // 欄が disabled になるので、Enter で送ったときもフォーカスを失わないよう、送るボタンへ移す
    submitButton?.focus();
    try {
      const result = await callOperation(storyCreate, { workspace_id: workspaceId, ...fields }, { slug });
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          await invalidateAll();
          return;
        }
        if (result.status === 409 && result.error?.code === 'workspace_closed') {
          submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
          reloadOnClose = true;
        } else if (result.status === 404 && fields.category_id !== null) {
          // 選んだ区分が削除されていた。一覧を読み直して、選び直してもらう
          submitError = t('definitionRefGone', { kind: t('category') });
          category = '';
          void invalidateAll();
        } else if (result.status === 400) {
          // 画面の検査を通った後に断られた。どの欄かは分からないので、タイトルを責めずに全体の文で知らせる
          submitError = t('storyBadRequest');
        } else {
          submitError = t('storyCreateFailed');
        }
        return;
      }
      open = false;
      if (announceCreated) showToast(t('storyCreated', { story: t('story') }), 'check');
      onsaved(result.data.story.id);
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(submitting ? t('storyCreating') : '');
  // 「開く」で開けるのは、いま入っているリンクが使える URL のときだけ
  const openHref = $derived.by(() => {
    const value = normalizeLinkUrl(link);
    return value !== null && linkUrlProblem(value) === null ? canonicalLinkUrl(value) : null;
  });
</script>

{#snippet error(name: FieldName)}
  {#if errors[name] !== undefined}
    <span class="field-error" id="{fieldIds[name]}-error" role="alert"><Icon name="alert" />{errors[name]}</span>
  {/if}
{/snippet}

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('storyCreate', { story: t('story') })}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <!-- 送っている間は、欄も変えられない。送るボタンはフォーカスを残すため、欄のまとまりの外で aria-disabled にしている -->
    <fieldset class="form-fields" disabled={submitting}>
      <div class="field" class:is-invalid={errors.title !== undefined}>
        <label class="field-label" for={fieldIds.title}>{t('fieldTitle')}</label>
        <input
          class="input"
          id={fieldIds.title}
          bind:value={title}
          oninput={() => (errors.title = undefined)}
          placeholder={t('storyTitlePlaceholder')}
          autocomplete="off"
          aria-invalid={errors.title !== undefined}
          aria-describedby={errors.title !== undefined ? `${fieldIds.title}-error` : undefined}
        />
        {@render error('title')}
      </div>

      <div class="field" class:is-invalid={errors.acceptance !== undefined}>
        <label class="field-label" for={fieldIds.acceptance}>{t('ac')}</label>
        <textarea
          class="textarea"
          id={fieldIds.acceptance}
          bind:value={acceptance}
          oninput={() => (errors.acceptance = undefined)}
          aria-invalid={errors.acceptance !== undefined}
          aria-describedby={errors.acceptance !== undefined ? `${fieldIds.acceptance}-error` : undefined}></textarea>
        {@render error('acceptance')}
      </div>

      <div class="field" class:is-invalid={errors.body !== undefined}>
        <label class="field-label" for={fieldIds.body}>{t('fieldBody')}</label>
        <textarea
          class="textarea"
          id={fieldIds.body}
          bind:value={body}
          oninput={() => (errors.body = undefined)}
          aria-invalid={errors.body !== undefined}
          aria-describedby={errors.body !== undefined ? `${fieldIds.body}-error` : undefined}></textarea>
        {@render error('body')}
      </div>

      <div class="field">
        <label class="field-label" for={categoryId}>{t('category')}</label>
        <select
          class="select"
          id={categoryId}
          bind:value={category}
          aria-describedby={categoriesFailed ? `${categoryId}-note` : undefined}
        >
          <option value="">{t('categoryNone', { category: t('category') })}</option>
          {#each categories as option (option.id)}
            <option value={option.id}>{option.name}</option>
          {/each}
        </select>
        {#if categoriesFailed}
          <span class="field-hint" id="{categoryId}-note"
            >{t('definitionsLoadFailed', { category: t('category') })}</span
          >
        {/if}
      </div>

      <div class="form-row is-start">
        <div class="field" class:is-invalid={errors.due !== undefined}>
          <label class="field-label" for={fieldIds.due}>{t('due')}</label>
          <input
            class="input"
            id={fieldIds.due}
            type="date"
            bind:this={dueInput}
            bind:value={dueOn}
            oninput={() => (errors.due = undefined)}
            aria-invalid={errors.due !== undefined}
            aria-describedby={errors.due !== undefined ? `${fieldIds.due}-error` : undefined}
          />
          {@render error('due')}
        </div>
        <div class="field" class:is-invalid={errors.link !== undefined}>
          <label class="field-label" for={fieldIds.link}>{t('fieldLink')}</label>
          <div class="input-row">
            <input
              class="input"
              id={fieldIds.link}
              type="url"
              bind:value={link}
              oninput={() => (errors.link = undefined)}
              placeholder={t('linkPlaceholder')}
              autocomplete="off"
              aria-invalid={errors.link !== undefined}
              aria-describedby={errors.link !== undefined ? `${fieldIds.link}-error` : undefined}
            />
            {#if openHref !== null}
              <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める -->
              <a
                class="btn"
                href={openHref}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
              >
            {/if}
          </div>
          {@render error('link')}
        </div>
      </div>
    </fieldset>

    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <!-- 状態の読み上げの領域。form の外に常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form={formId} aria-disabled={submitting} bind:this={submitButton}>
      {submitting ? status : t('storyCreateSubmit')}
    </button>
  {/snippet}
</Dialog>
