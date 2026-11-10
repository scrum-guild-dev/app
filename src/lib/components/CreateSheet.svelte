<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { afterNavigate, beforeNavigate, goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { callOperation } from '../api.ts';
  import { modalState, showToast } from '../toast.svelte.ts';
  import { focusPageHeading } from '../focus-heading.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { backlogTree, taskCreate } from '../../shared/operations/task/index.ts';
  import { storyCreate } from '../../shared/operations/story/index.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { TASK_POINT_VALUES } from '../../shared/task.ts';
  import Icon from './Icon.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import AttrChip from './AttrChip.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import ToastRegion from './ToastRegion.svelte';

  let { slug, workspaceId, id }: { slug: string; workspaceId: string; id: string } = $props();
  const uid = $props.id();
  let dialog: HTMLDialogElement;
  let trigger: HTMLButtonElement | null = null;
  let titleInput: HTMLInputElement;
  let discard: ReturnType<typeof ConfirmDialog>;
  let open = $state(false);
  let confirming = $state(false);
  let busy = $state(false);
  let kind = $state<'task' | 'story'>('task');
  let title = $state('');
  let body = $state('');
  let storyId = $state('');
  let epicId = $state('');
  let assignee = $state('');
  let points = $state('');
  let due = $state('');
  let failure = $state('');
  let choicesFailed = $state(false);
  let loading = $state(false);
  let tree = $state<OutputOf<typeof backlogTree> | null>(null);
  const dirty = $derived(!!(title || body || storyId || epicId || assignee || points || due));
  const stories = $derived(
    tree
      ? [
          ...tree.epics.filter((epic) => !epic.completed_at && !epic.canceled_at).flatMap((epic) => epic.stories),
          ...tree.stories,
        ].filter((story) => !story.completed_at)
      : [],
  );
  const epics = $derived(tree?.choices.epics.filter((epic) => !epic.finished) ?? []);
  const people = $derived(tree?.choices.assignees.filter((person) => person.current) ?? []);
  const locked = $derived(busy ? t('storyCreating') : loading ? t('loading') : undefined);

  async function loadChoices(): Promise<void> {
    if (loading) return;
    loading = true;
    const result = await callOperation(backlogTree, { workspace_id: workspaceId }, { slug });
    loading = false;
    choicesFailed = !result.ok;
    if (result.ok) tree = result.data;
  }

  export function show(opener: HTMLButtonElement): void {
    trigger = opener;
    open = true;
    dialog.showModal();
    titleInput.focus();
    void loadChoices();
  }

  function finish(): void {
    open = false;
    dialog.close();
    const opener = document.getElementById(`${id}-trigger`) ?? trigger;
    opener?.focus();
    if (document.activeElement !== opener) focusPageHeading();
    title = body = storyId = epicId = assignee = points = due = failure = '';
  }

  async function mayDiscard(): Promise<boolean> {
    if (busy || confirming) return false;
    if (!dirty) return true;
    confirming = true;
    const answer = await discard.ask();
    confirming = false;
    return answer;
  }

  async function close(): Promise<void> {
    if (await mayDiscard()) finish();
  }

  // 遷移が終わる直前に開いたときも、SvelteKit のフォーカス復帰の後で題へ置く。
  afterNavigate(() => {
    if (open && !confirming && !dialog.contains(document.activeElement)) titleInput.focus();
  });

  beforeNavigate((navigation) => {
    if (!open) return;
    if (busy || confirming) {
      navigation.cancel();
      return;
    }
    if (!dirty) {
      finish();
      return;
    }
    navigation.cancel();
    if (navigation.type === 'leave') return;
    const url = navigation.to?.url;
    if (url)
      void mayDiscard().then((answer) => {
        if (answer) {
          finish();
          // eslint-disable-next-line svelte/no-navigation-without-resolve -- SvelteKit が解決した遷移先を再開する
          void goto(url);
        }
      });
  });

  // キーボードを出しても上の「作る」が見えるよう、シートを visualViewport に合わせる。
  onMount(() => {
    const viewport = window.visualViewport;
    const place = () => {
      dialog.style.setProperty('--create-height', `${viewport?.height ?? window.innerHeight}px`);
      dialog.style.setProperty('--create-top', `${viewport?.offsetTop ?? 0}px`);
    };
    place();
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    const unload = (event: BeforeUnloadEvent) => {
      if (open && (dirty || busy)) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
      window.removeEventListener('beforeunload', unload);
    };
  });
  $effect(() => {
    if (!open) return;
    untrack(() => modalState.openCount++);
    return () => untrack(() => modalState.openCount--);
  });

  async function create(): Promise<void> {
    if (busy || !title.trim()) return;
    busy = true;
    failure = '';
    const createdKind = kind;
    const createdTitle = title.trim();
    const common = { workspace_id: workspaceId, title: createdTitle, body_md: body || null };
    const result =
      kind === 'task'
        ? await callOperation(
            taskCreate,
            {
              ...common,
              story_id: storyId || null,
              assignee_user_id: assignee || null,
              points: points === '' ? null : (Number(points) as (typeof TASK_POINT_VALUES)[number]),
            },
            { slug },
          )
        : await callOperation(storyCreate, { ...common, epic_id: epicId || null, due_on: due || null }, { slug });
    busy = false;
    if (!result.ok) {
      failure =
        result.status === 403 || result.error?.code === 'workspace_closed'
          ? t('createSheetUnavailable')
          : result.status === 404
            ? t('createSheetGone')
            : result.status === 409
              ? t('createSheetConflict')
              : result.status === 400
                ? t('storyBadRequest')
                : t('createSheetFailed');
      if (result.status === 404 || result.status === 409) void loadChoices();
      return;
    }
    const id = 'task' in result.data ? result.data.task.id : result.data.story.id;
    finish();
    await tick();
    showToast(t('createSheetCreated', { kind: t(createdKind), title: createdTitle }), 'check', {
      label: t('createSheetOpen'),
      run: () => {
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve 済みのバックログへ作成対象のクエリを足す
        void goto(`${resolve('/[slug]/w/[id]', { slug, id: workspaceId })}?${createdKind}=${encodeURIComponent(id)}`);
      },
    });
    // 済んだ作成を読み直しの失敗で失敗扱いにしない。
    void invalidate('app:backlog-tree').catch(() => {
      showToast(t('createSheetReloadFailed'), 'alert');
    });
  }
</script>

<dialog
  class="create-sheet"
  {id}
  bind:this={dialog}
  aria-label={t('createSheet')}
  oncancel={(event) => {
    event.preventDefault();
    void close();
  }}
  onclose={() => {
    // Chromium が cancel を飛ばして閉じても、書きかけを失わせない。
    if (open && !dialog.open) {
      dialog.showModal();
      titleInput.focus();
      void close();
    }
  }}
>
  <form
    class="create-sheet-form"
    onsubmit={(event) => {
      event.preventDefault();
      void create();
    }}
  >
    <header class="create-sheet-head">
      <button
        class="icon-btn"
        type="button"
        aria-label={t('close')}
        aria-disabled={busy || confirming}
        onclick={() => void close()}><Icon name="x" /></button
      >
      <div class="create-sheet-kind" role="group" aria-label={t('createKind')}>
        <button
          class="btn is-sm"
          class:is-on={kind === 'task'}
          type="button"
          aria-pressed={kind === 'task'}
          disabled={busy}
          onclick={() => (kind = 'task')}>{t('task')}</button
        >
        <button
          class="btn is-sm"
          class:is-on={kind === 'story'}
          type="button"
          aria-pressed={kind === 'story'}
          disabled={busy}
          onclick={() => (kind = 'story')}>{t('story')}</button
        >
      </div>
      <button
        class="btn is-primary create-sheet-submit"
        type="submit"
        aria-label={t(busy ? 'storyCreating' : 'storyCreateSubmit')}
        aria-disabled={busy || !title.trim()}
        aria-describedby={!title.trim() ? `${uid}-reason` : undefined}><Icon name="up" /></button
      >
    </header>
    <div class="create-sheet-body">
      {#if !title.trim()}<p class="muted" id={`${uid}-reason`}>{t('taskTitleRequired')}</p>{/if}
      {#if failure}<p class="callout is-danger" role="alert">{failure}</p>{/if}
      <label class="field"
        ><span class="field-label">{t('fieldTitle')}</span><input
          class="input create-sheet-title"
          id={`${uid}-title`}
          bind:this={titleInput}
          bind:value={title}
          readonly={busy}
          placeholder={t(kind === 'task' ? 'taskTitlePlaceholder' : 'storyTitlePlaceholder')}
        /></label
      >
      <div class="field">
        <label class="field-label" for={`${uid}-body`}>{t('fieldBody')}</label><MarkdownEditor
          id={`${uid}-body`}
          bind:value={body}
          {slug}
          {workspaceId}
          readonly={busy}
          attachments={false}
        />
      </div>
      <div class="create-sheet-attrs">
        {#if kind === 'task'}
          <AttrChip
            attr={t('taskParent', { story: t('story') })}
            text={stories.find((s) => s.id === storyId)?.title ?? t('taskParentNone')}
            unset={!storyId}
            current={storyId}
            options={[
              { value: '', text: t('taskParentNone') },
              ...stories.map((s) => ({ value: s.id, text: s.title })),
            ]}
            onselect={(value) => (storyId = value)}
            {locked}
          />
          <AttrChip
            attr={t('assignee')}
            text={people.find((p) => p.id === assignee)?.name ?? t('taskParentNone')}
            unset={!assignee}
            current={assignee}
            options={[{ value: '', text: t('taskParentNone') }, ...people.map((p) => ({ value: p.id, text: p.name }))]}
            onselect={(value) => (assignee = value)}
            {locked}
          />
          <AttrChip
            attr={t('points')}
            text={points || t('taskParentNone')}
            unset={points === ''}
            current={points}
            options={[
              { value: '', text: t('taskParentNone') },
              ...TASK_POINT_VALUES.map((p) => ({ value: String(p), text: String(p) })),
            ]}
            onselect={(value) => (points = value)}
            locked={busy ? t('storyCreating') : undefined}
          />
        {:else}
          <AttrChip
            attr={t('epic')}
            text={epics.find((e) => e.id === epicId)?.title ?? t('taskParentNone')}
            unset={!epicId}
            current={epicId}
            options={[{ value: '', text: t('taskParentNone') }, ...epics.map((e) => ({ value: e.id, text: e.title }))]}
            onselect={(value) => (epicId = value)}
            {locked}
          />
          <AttrChip
            attr={t('due')}
            text={due || t('taskParentNone')}
            unset={!due}
            current={due}
            options={[]}
            onselect={() => {}}
            locked={busy ? t('storyCreating') : undefined}
          >
            {#snippet panel(closePanel)}
              <label class="field"
                ><span class="field-label">{t('due')}</span><input class="input" type="date" bind:value={due} /></label
              >
              <button class="btn" type="button" onclick={closePanel}>{t('close')}</button>
            {/snippet}
          </AttrChip>
        {/if}
      </div>
      {#if loading}<p role="status">{t('loading')}</p>{/if}
      {#if choicesFailed}<p class="field-error" role="alert">{t('createChoicesFailed')}</p>
        <button class="btn" type="button" disabled={loading || busy} onclick={() => void loadChoices()}
          >{t('retry')}</button
        >{/if}
    </div>
  </form>
  <ToastRegion inDialog />
</dialog>
<ConfirmDialog
  bind:this={discard}
  title={t('discardTitle')}
  confirmLabel={t('discardConfirm')}
  cancelLabel={t('discardKeep')}><p>{t('discardText')}</p></ConfirmDialog
>
