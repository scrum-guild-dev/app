<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation } from '../../../../../lib/api.ts';
  import Avatar from '../../../../../lib/components/Avatar.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import { formatLocalDateTime } from '../../../../../lib/format.ts';
  import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    INBOX_MOVE_LIMIT,
    inboxMoveConflictReasonOf,
    inboxToBacklog,
    type InboxTask,
  } from '../../../../../shared/operations/task/index.ts';
  import type { PageProps } from './$types';

  // 受信箱の画面（design/inbox.html）。新しく取り込んだタスクを、取り込み元のキー、届いた日時、接続の名前、リポジトリ、担当と並べ、
  // メンバーなら誰でもバックログへ入れられる（行の「バックログへ」と、選んだものをまとめて入れる帯）。入れたタスクは
  // バックログの親のない末尾へ並び、受信箱から消える。リポジトリが未定の行は、入れる前に選べる。
  // 接続が無いときは、接続の登録を促す空の状態を出す（接続の登録の画面は別のストーリーで足す）。最後に成功した同期の日時を帯に出す。
  // 終了したワークスペースでは、入れる操作を出さない。一度に入れられるのは INBOX_MOVE_LIMIT 件まで。
  // 入れた後は一覧を読み直し、バックログの木も読み直す印（app:backlog-tree）を立てる。入れる間は、ほかの操作を押しても無視する。
  // 受信箱に無いタスクが混じったとき（409）と、タスクが見つからないとき（404）は、何も入れずに読み直す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const inbox = $derived(data.inbox);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);

  // 選んだ行の ID と、行ごとに選んだリポジトリ（空は未選択）。読み直した後に残っていない ID は捨てる
  let selected = $state<string[]>([]);
  let repositoryOf = $state<Record<string, string>>({});
  let working = $state(false);
  let heading = $state<HTMLElement>();

  const tasks = $derived(inbox?.tasks ?? []);
  const visible = $derived(new Set(tasks.map((task) => task.id)));
  const chosen = $derived(selected.filter((id) => visible.has(id)));
  const allChosen = $derived(tasks.length > 0 && chosen.length === Math.min(tasks.length, INBOX_MOVE_LIMIT));
  const overLimit = $derived(chosen.length > INBOX_MOVE_LIMIT);

  function toggle(id: string, on: boolean): void {
    selected = on ? [...selected.filter((item) => item !== id), id] : selected.filter((item) => item !== id);
  }

  function toggleAll(on: boolean): void {
    selected = on ? tasks.slice(0, INBOX_MOVE_LIMIT).map((task) => task.id) : [];
  }

  function itemOf(task: InboxTask) {
    const repositoryId = repositoryOf[task.id];
    return repositoryId ? { task_id: task.id, repository_id: repositoryId } : { task_id: task.id };
  }

  async function reload(): Promise<void> {
    await invalidate('app:inbox');
    // 読み直した後に残っていない行の印は捨てる
    await tick();
    selected = selected.filter((id) => visible.has(id));
    // 読み直した後に選べなくなったリポジトリ（削除された）の選びは捨てる
    const live = new Set(inbox?.repositories.map((repository) => repository.id));
    for (const [id, repositoryId] of Object.entries(repositoryOf)) {
      if (repositoryId !== '' && !live.has(repositoryId)) delete repositoryOf[id];
    }
  }

  async function moveTasks(targets: InboxTask[]): Promise<void> {
    if (working || workspace === null || targets.length === 0) return;
    if (targets.length > INBOX_MOVE_LIMIT) {
      showToast(t('inboxSelectLimit', { limit: INBOX_MOVE_LIMIT }), 'alert');
      return;
    }
    working = true;
    try {
      const result = await callOperation(
        inboxToBacklog,
        { workspace_id: workspace.id, items: targets.map(itemOf) },
        { slug },
      );
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) {
        const words = { backlog: t('backlog') };
        const [only] = targets;
        showToast(
          targets.length === 1 && only !== undefined
            ? t('inboxMovedOne', { title: only.title, ...words })
            : t('inboxMoved', { count: result.data.moved, ...words }),
          'check',
        );
        selected = selected.filter((id) => !targets.some((task) => task.id === id));
        await invalidate('app:backlog-tree');
      } else if (result.error?.code === 'workspace_closed') {
        showToast(t('inboxMoveClosed', { workspace: t('workspace') }), 'alert');
        await invalidate('app:workspace');
      } else if (result.error?.code === 'conflict' && inboxMoveConflictReasonOf(result.error.details) !== undefined) {
        showToast(t('inboxMoveStale', { inbox: t('inbox') }), 'alert');
      } else if (result.status === 404) showToast(t('inboxMoveNotFound', { task: t('task') }), 'alert');
      else if (result.status === 0) showToast(t('inboxMoveUnreachable'), 'alert');
      else showToast(t('inboxMoveFailed'), 'alert');
      await reload();
    } finally {
      working = false;
    }
    // 押した行が消えて、フォーカスが body に落ちたら見出しへ移す
    await tick();
    if (document.activeElement === document.body || document.activeElement === null) {
      heading ??= document.querySelector<HTMLElement>('h1') ?? undefined;
      heading?.setAttribute('tabindex', '-1');
      heading?.focus();
    }
  }
</script>

<svelte:head>
  {#if workspace && inbox !== null}
    <title>
      {t('pageTitle', {
        page: t('inboxPageName', { inbox: t('inbox'), name: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#if workspace && inbox === null}
  <LoadFailed inShell />
{:else if workspace && inbox !== null}
  <PageHead
    title={t('inbox')}
    eyebrow={workspace.name}
    tallies={[{ icon: 'inbox', label: t('inboxTallyArrived'), count: inbox.total }]}
  />

  {#if inbox.connection_count === 0 && tasks.length === 0}
    <EmptyState
      icon="inbox"
      art="notice"
      title={t('inboxNoConnectionTitle', { connection: t('connection') })}
      text={t('inboxNoConnectionText', { connection: t('connection') })}
    />
  {:else}
    <div class="callout is-info">
      <Icon name="refresh" /><span
        >{inbox.last_success_at === null
          ? t('inboxNeverSynced', { workspace: t('workspace') })
          : t('inboxSynced', {
              date: formatLocalDateTime(inbox.last_success_at),
              workspace: t('workspace'),
            })}</span
      >
    </div>
    {#if tasks.length === 0}
      <EmptyState icon="inbox" title={t('inboxEmptyTitle')} text={t('inboxEmptyText', { task: t('task') })} />
    {:else}
      {#if canWrite}
        <div class="toolbar">
          <label class="toggle" for="inbox-all">
            <input
              id="inbox-all"
              type="checkbox"
              checked={allChosen}
              aria-disabled={working}
              onchange={(event) => {
                // 送っている間の変更は無視し、見た目を状態に戻す（aria-disabled は押せるままなので）
                if (working) event.currentTarget.checked = allChosen;
                else toggleAll(event.currentTarget.checked);
              }}
            /><span
              >{tasks.length > INBOX_MOVE_LIMIT
                ? t('inboxSelectFirst', { limit: INBOX_MOVE_LIMIT })
                : t('inboxSelectAll')}</span
            >
          </label>
          <button
            class="btn is-sm"
            type="button"
            aria-disabled={working || chosen.length === 0 || overLimit}
            onclick={() => moveTasks(tasks.filter((task) => chosen.includes(task.id)))}
            >{t('inboxMoveSelected', { backlog: t('backlog') })}</button
          >
          <span class="field-hint" role="status"
            >{overLimit
              ? t('inboxSelectLimit', { limit: INBOX_MOVE_LIMIT })
              : chosen.length > 0
                ? t('inboxSelectedCount', { count: chosen.length })
                : working
                  ? t('inboxMoveWorking', { backlog: t('backlog') })
                  : t('inboxSelectHint', { task: t('task') })}</span
          >
        </div>
      {/if}
      <div class="book" role="list" aria-label={t('inboxListLabel', { inbox: t('inbox'), task: t('task') })}>
        {#each tasks as task (task.id)}
          <div class="entry" role="listitem" data-row-id={task.id}>
            {#if canWrite}
              <label class="row-check">
                <input
                  type="checkbox"
                  aria-label={t('inboxSelectRow', { title: task.title })}
                  aria-disabled={working}
                  checked={chosen.includes(task.id)}
                  onchange={(event) => {
                    if (working) event.currentTarget.checked = chosen.includes(task.id);
                    else toggle(task.id, event.currentTarget.checked);
                  }}
                />
              </label>
            {:else}
              <span aria-hidden="true"></span>
            {/if}
            <div class="entry-main">
              <span class="entry-title">{task.title}</span>
              <span class="entry-meta">
                {#if /^https?:\/\//i.test(task.source_url)}
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- 取り込み元の絶対 URL（http か https のものだけリンクにする） -->
                  <a class="source-key is-wrap" href={task.source_url} target="_blank" rel="noopener noreferrer"
                    ><Icon name="link" /> {task.source_key}</a
                  >
                {:else}
                  <span class="source-key is-wrap"><Icon name="link" /> {task.source_key}</span>
                {/if}
                <span>{t('inboxArrived', { date: formatLocalDateTime(task.arrived_at) })}</span>
                <span>{task.connection_name}</span>
                {#if canWrite && inbox.repositories.length > 0}
                  <select
                    class="select"
                    aria-label={t('inboxRepositoryLabel', { title: task.title, repository: t('repository') })}
                    value={repositoryOf[task.id] ?? task.repository?.id ?? ''}
                    onchange={(event) => (repositoryOf[task.id] = event.currentTarget.value)}
                  >
                    {#if task.repository === null}
                      <option value="">{t('inboxRepositoryNone', { repository: t('repository') })}</option>
                    {/if}
                    {#each inbox.repositories as repository (repository.id)}
                      <option value={repository.id}>{repository.name}</option>
                    {/each}
                  </select>
                {:else if task.repository}
                  <span>{task.repository.name}</span>
                {/if}
              </span>
            </div>
            <div class="entry-end">
              {#if task.assignee === null}
                <Avatar userId={null} />
              {:else}
                <Avatar userId={task.assignee.id} name={task.assignee.name} />
              {/if}
              {#if canWrite}
                <button
                  class="btn is-primary is-sm"
                  type="button"
                  aria-disabled={working}
                  aria-label={t('inboxMoveRowLabel', { title: task.title, backlog: t('backlog') })}
                  onclick={() => moveTasks([task])}>{t('inboxMoveRow', { backlog: t('backlog') })}</button
                >
              {/if}
            </div>
          </div>
        {/each}
      </div>
      {#if inbox.total > tasks.length}
        <p class="action-note">{t('inboxLimitNote', { shown: tasks.length, total: inbox.total })}</p>
      {/if}
      <p class="action-note">{t('inboxNote', { backlog: t('backlog'), sprint: t('sprint'), today: t('pageToday') })}</p>
    {/if}
  {/if}
{/if}
