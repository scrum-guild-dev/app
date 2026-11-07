<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Icon from '../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import NotFoundPage from '../../../../lib/components/NotFoundPage.svelte';
  import EpicDrawer from '../../../../lib/components/EpicDrawer.svelte';
  import StoryDrawer from '../../../../lib/components/StoryDrawer.svelte';
  import TaskDrawer from '../../../../lib/components/TaskDrawer.svelte';
  import {
    adjacentTaskIds,
    drawerState,
    storyOrder,
    taskOrder,
    clearOverlayHandoff,
    markOverlayHandoff,
    openTaskTab,
    setTaskOpenMode,
    taskPageHref,
    type TaskOpenMode,
  } from '../../../../lib/drawer.svelte.ts';
  import { focusPageHeading } from '../../../../lib/focus-heading.ts';
  import { formatLocalDate } from '../../../../lib/format.ts';
  import { epicFinishedOf, parentChoicesOf, storyFactsOf, storyTreeOf } from '../../../../lib/story-drawer.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import type { LayoutData } from './$types';

  // ワークスペースの枠。
  // 左のメニューのワークスペースの節と、上の帯の「所属せず管理者として開いています」の印は、組織の枠が page.data から出す。
  // 存在しない ID と別の組織の ID（404）は、同じ「見つからない」。所属していない一般のユーザー（403）も、
  // 読み直しても直らないので「入れない」の案内にする（組織の枠の 403 とは違い、ここでは「もう一度試す」を出さない）。
  // ほかの失敗（通信、5xx）は読み込みの失敗。
  // 終了したワークスペースには、読み取り専用の帯を出す（部品は components.css の .callout）
  // タスクの詳細の引き出しは、URL の `?task=<ID>` が付いている間、ワークスペースのどの画面の上にも置く（タスクが替わったら、置き直す）。
  // 閉じるときは、開いている画面の URL から `task` だけを外し（履歴は積まない）、開いた行のリンクへフォーカスを戻す。行が無ければ（消えた、
  // 画面にまだ無い）画面の見出しへ移す。保存した欄は、木だけを読み直して行に反映する（`app:backlog-tree`）。引き出しが読み直すのは、
  // 木かこの枠（`app:workspace`）だけで、組織の枠は読み直さない（組織の枠の失敗で、引き出しと書きかけが消えないため）。
  // 終了したワークスペースでは、引き出しを読み取り専用で開く
  // ページ全体（tasks/[taskId]）は、ルートが TaskDrawer を置くので、ここでは引き出しを重ねない
  // 引き出しの帯に、前後のタスクへ移るボタンを出す。順は開いた画面が置く（バックログ、計画、スプリント。画面の見えている行の順で、端で止まる）。
  // 移るときは `?task=` を置き換え（履歴は積まない）、引き出しは置き直される。閉じたときのフォーカスは、最後に表示したタスクの行へ戻る（下の shownTaskId）
  // ストーリーの引き出し（StoryDrawer）は、URL の `?story=<ID>` が付いている間、同じ形で置く。タスクの引き出しと同時には開かない
  // （行のリンクが、もう一方の問い合わせを外す。両方が付いた URL は、タスクの方だけを開く）。開き方は横か真ん中だけ（ページ全体は無い）。
  // 閉じるときは `story` だけを外し、開いた行の題（data-story-id）へフォーカスを戻す。前後のストーリーへは、バックログが置いた木のストーリーの順（storyOrder）で移る。
  // 完了の状態、期日の印の今日、親に選べるエピックは、バックログが読んだ木（page.data.tree）から渡す。木が無い画面や、絞り込みで木から外れたストーリーでは、
  // 引き出しは完了の操作と親を移すを出さない
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const workspace = $derived(data.workspace);
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  const status = $derived(data.workspaceFailure?.status);
  const code = $derived(data.workspaceFailure?.code);
  const unavailable = $derived((status === 404 && code === 'not_found') || (status === 403 && code === 'forbidden'));
  const taskId = $derived(page.params.taskId ? null : page.url.searchParams.get('task'));
  const storyId = $derived(page.params.taskId || taskId !== null ? null : page.url.searchParams.get('story'));
  // エピックの引き出しも、タスクとストーリーの引き出しと同時には開かない（付いていれば、そちらを開く）
  const epicId = $derived(
    page.params.taskId || taskId !== null || storyId !== null ? null : page.url.searchParams.get('epic_id'),
  );
  let modeRevision = $state(0);
  const overlayMode = $derived(drawerState.mode === 'center' ? 'center' : 'side');

  // 帯で形を替える（書きかけの確認は TaskDrawer が済ませている）。移れなかったとき（新しいタブを開けなかった）は false を返し、
  // 引き出しも既定もそのままにする
  function changeMode(mode: TaskOpenMode): boolean {
    if (!taskId) return true;
    if (mode === 'tab') {
      if (!openTaskTab(taskPageHref(data.slug, workspace!.id, taskId))) return false;
      setTaskOpenMode(mode);
      void withoutTask();
      return true;
    }
    setTaskOpenMode(mode);
    if (mode === 'page') {
      // 一覧の上の引き出しからページ全体へ移っても履歴は足さない。足すと、ページ全体を閉じたとき引き出しが開いた状態の一覧に戻る
      markOverlayHandoff();
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 同じワークスペース内の詳細の URL
      void goto(taskPageHref(data.slug, workspace!.id, taskId), { replace: true }).finally(() => {
        // 移れていれば（URL がページ全体）、ページ側の afterNavigate が印を読む。移れなかったときだけ外す
        if (!location.pathname.includes('/tasks/')) clearOverlayHandoff();
      });
    } else modeRevision += 1;
    return true;
  }
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // 前後のタスク。開いた画面が置いた、今見えている行の順（task-order.ts）の中の隣。順に無い（画面が順を置かない、完了して外れた）ときは渡さない
  const adjacent = $derived(taskId === null ? null : adjacentTaskIds(taskOrder.ids, taskId));

  // 前後のタスクへ移る（書きかけの確認は TaskDrawer が済ませている）。`?task=` だけを置き換え、ほかのクエリは残す。履歴は積まない
  function stepTo(id: string): Promise<void> {
    const query = new SvelteURLSearchParams(page.url.search);
    query.set('task', id);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、残すクエリと task だけを足している
    return goto(`${page.url.pathname}?${query}`, { replace: true, reset: false });
  }

  // 今の URL から `task` を外した画面。開いた画面（バックログ、メンバーなど）のまま、ほかのクエリも残す。
  // `story` も一緒に外す（両方が付いた URL はタスクの方だけが開いているので、`story` を残すと、閉じた途端にストーリーの引き出しが開く）
  const withoutTask = () => {
    const rest = new SvelteURLSearchParams(page.url.search);
    rest.delete('task');
    rest.delete('story');
    rest.delete('epic_id');
    const query = rest.size > 0 ? `?${rest}` : '';
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、残すクエリだけを足している
    return goto(page.url.pathname + query, {
      replace: true,
      reset: false,
    });
  };

  // 閉じたら、開いた行の題（data-task-id を持つリンクか、バックログの完了した行の題のボタン）へフォーカスを戻す。
  // 行が無ければ（消えた、画面にまだ無い）画面の見出しへ移す。
  // 閉じるボタンと Esc だけでなく、戻る／進むで `?task=` が外れて閉じたときも同じ。タスクが消えて閉じたときは、
  // 木を読み直した後に見出しへ移す（removed）ので、ここでは移さない
  let shownTaskId: string | null = null;
  let focusAfterReload = false;
  $effect(() => {
    const previous = shownTaskId;
    shownTaskId = taskId;
    if (previous === null || taskId !== null) return;
    // 引き出しからページ全体へ移ったときも taskId は null になる。ページ全体の TaskDrawer が置いたフォーカスを奪わない
    if (page.params.taskId) return;
    // ストーリーの引き出しへ移ったときも。ストーリーの引き出しが置いたフォーカスを奪わない
    if (storyId !== null) return;
    if (focusAfterReload) {
      focusAfterReload = false;
      return;
    }
    void tick().then(() => {
      const row = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(previous)}"]`);
      if (row) row.focus();
      else focusPageHeading();
    });
  });

  // タスクが消えた（削除した、見つからない）。閉じて、木を読み直し、フォーカスを見出しへ移す（戻る先の行が無いため）
  async function removed(): Promise<void> {
    focusAfterReload = true;
    await withoutTask();
    await invalidate('app:backlog-tree');
    await tick();
    focusPageHeading();
  }

  // ---- ストーリーの引き出し ----
  const storyAdjacent = $derived(storyId === null ? null : adjacentTaskIds(storyOrder.ids, storyId));
  // 木のストーリーの行。完了の状態、期日の印の今日と週の始まり、親に選べるエピック。バックログの画面が読んだ木から取る
  const storyTree = $derived(storyTreeOf(page.data));
  const storyFacts = $derived(storyId === null ? null : storyFactsOf(storyTree, storyId));
  const storyClock = $derived(storyTree === null ? null : { today: storyTree.today, weekStart: storyTree.week_start });
  const storyParents = $derived(parentChoicesOf(storyTree));

  // 帯で形を替える（書きかけの確認は StoryDrawer が済ませている）。ストーリーの引き出しは横と真ん中だけ
  function changeStoryMode(mode: TaskOpenMode): boolean {
    setTaskOpenMode(mode);
    modeRevision += 1;
    return true;
  }

  // 前後のストーリーへ移る。`?story=` だけを置き換え、ほかのクエリは残す。履歴は積まない
  function stepToStory(id: string): Promise<void> {
    const query = new SvelteURLSearchParams(page.url.search);
    query.set('story', id);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、残すクエリと story だけを足している
    return goto(`${page.url.pathname}?${query}`, { replace: true, reset: false });
  }

  // 今の URL から `story` だけを外した画面
  const withoutStory = () => {
    const rest = new SvelteURLSearchParams(page.url.search);
    rest.delete('story');
    rest.delete('epic_id');
    const query = rest.size > 0 ? `?${rest}` : '';
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、残すクエリだけを足している
    return goto(page.url.pathname + query, { replace: true, reset: false });
  };

  // 閉じたら、開いた行の題（data-story-id を持つリンク）へフォーカスを戻す。行が無ければ（畳んだ枝の中も含む）画面の見出しへ移す。
  // 戻る／進むで `?story=` が外れて閉じたときも同じ。ストーリーが消えて閉じたときは、木を読み直した後に見出しへ移す（removedStory）。
  // タスクの引き出しへ移ったときは、タスクの引き出しが置いたフォーカスを奪わない
  let shownStoryId: string | null = null;
  let focusStoryAfterReload = false;
  $effect(() => {
    const previous = shownStoryId;
    shownStoryId = storyId;
    if (previous === null || storyId !== null) return;
    if (taskId !== null) return;
    if (focusStoryAfterReload) {
      focusStoryAfterReload = false;
      return;
    }
    void tick().then(() => {
      const row = document.querySelector<HTMLElement>(`[data-story-id="${CSS.escape(previous)}"]`);
      // 畳んだ行（hidden の枝）の中の題は、focus() が効かずフォーカスが失われる。畳んでいれば見出しへ移す
      if (row && !row.closest('[hidden]')) row.focus();
      else focusPageHeading();
    });
  });

  // ストーリーが消えた（削除した、見つからない）。閉じて、木を読み直し、フォーカスを見出しへ移す（戻る先の行が無いため）
  async function removedStory(): Promise<void> {
    focusStoryAfterReload = true;
    await withoutStory();
    await invalidate('app:backlog-tree');
    await tick();
    focusPageHeading();
  }
  // ---- エピックの引き出し ----
  // 期日の印の今日と週の始まり、クリアか中止の状態は、バックログの画面が読んだ木から取る（無い画面では印を出さない）
  const epicFinished = $derived(epicId === null ? false : epicFinishedOf(storyTree, epicId));

  // 帯で形を替える（書きかけの確認は EpicDrawer が済ませている）。エピックの引き出しは横と真ん中だけ
  function changeEpicMode(mode: TaskOpenMode): boolean {
    setTaskOpenMode(mode);
    modeRevision += 1;
    return true;
  }

  // 今の URL から `epic` だけを外した画面
  const withoutEpic = () => {
    const rest = new SvelteURLSearchParams(page.url.search);
    rest.delete('epic_id');
    const query = rest.size > 0 ? `?${rest}` : '';
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、残すクエリだけを足している
    return goto(page.url.pathname + query, { replace: true, reset: false });
  };

  // 木とエピックの画面の値を読み直す（欄を保存した）。引き出しの書きかけを失わないため、枠は読み直さない
  async function reloadEpic(): Promise<void> {
    await Promise.all([invalidate('app:backlog-tree'), invalidate('app:epic-detail')]);
  }

  // 閉じたら、開いた題（data-epic-id を持つリンクかボタン）へフォーカスを戻す。無ければ（畳んだ枝の中も含む）画面の見出しへ移す。
  // 戻る／進むで `?epic_id=` が外れて閉じたときも同じ。エピックが消えて閉じたときは、読み直した後に見出しへ移す（removedEpic）
  let shownEpicId: string | null = null;
  let focusEpicAfterReload = false;
  $effect(() => {
    const previous = shownEpicId;
    shownEpicId = epicId;
    if (previous === null || epicId !== null) return;
    if (taskId !== null || storyId !== null) return;
    if (focusEpicAfterReload) {
      focusEpicAfterReload = false;
      return;
    }
    void tick().then(() => {
      const row = document.querySelector<HTMLElement>(`[data-epic-id="${CSS.escape(previous)}"]`);
      if (row && !row.closest('[hidden]')) row.focus();
      else focusPageHeading();
    });
  });

  // エピックが消えた（削除した、見つからない）。エピックの画面の上で開いていたら、その画面は無いのでバックログへ戻る。
  // そうでなければ、閉じて木を読み直し、フォーカスを見出しへ移す（戻る先の行が無いため）
  async function removedEpic(): Promise<void> {
    focusEpicAfterReload = true;
    if (page.params.epicId !== undefined) {
      await goto(resolve('/[slug]/w/[id]', { slug: data.slug, id: page.params.id ?? '' }), { refreshAll: true });
    } else {
      await withoutEpic();
      await invalidate('app:backlog-tree');
    }
    await tick();
    focusPageHeading();
  }
</script>

{#if workspace}
  <!-- 終了していれば、ワークスペースの中のどの画面にも帯を出す。再開するボタンは置かず、管理者には組織の管理の画面へのリンクを添える -->
  {#if workspace.closedAt !== null}
    <div class="callout is-info">
      <Icon name="archive" />
      <span>
        {t('workspaceClosedBanner', { date: formatLocalDate(workspace.closedAt) })}
        {#if isAdmin}
          <a href={resolve('/[slug]/admin', { slug: data.slug })}
            >{t('workspaceClosedBannerLink', { page: t('pageOrgAdmin') })}</a
          >
        {/if}
      </span>
    </div>
  {/if}
  {@render children()}
  {#if taskId !== null}
    {#key `${taskId}:${modeRevision}`}
      <TaskDrawer
        mode={overlayMode}
        onmode={changeMode}
        adjacent={adjacent ?? undefined}
        onstep={stepTo}
        slug={page.params.slug ?? ''}
        workspaceId={workspace.id}
        {taskId}
        currentUserId={data.organization?.me.id ?? null}
        {canWrite}
        definitionOfDone={workspace.definitionOfDone}
        onclose={() => void withoutTask()}
        onchanged={() => void invalidate('app:backlog-tree')}
        onstale={() => void invalidate('app:workspace')}
        onremoved={() => void removed()}
      />
    {/key}
  {/if}
  {#if storyId !== null}
    {#key `${storyId}:${modeRevision}`}
      <StoryDrawer
        mode={overlayMode}
        onmode={changeStoryMode}
        adjacent={storyAdjacent ?? undefined}
        onstep={stepToStory}
        slug={page.params.slug ?? ''}
        workspaceId={workspace.id}
        {storyId}
        {canWrite}
        facts={storyFacts}
        clock={storyClock}
        parents={storyParents}
        onclose={() => void withoutStory()}
        onchanged={() => invalidate('app:backlog-tree')}
        onstale={() => void invalidate('app:workspace')}
        onremoved={() => void removedStory()}
      />
    {/key}
  {/if}
  {#if epicId !== null}
    {#key `${epicId}:${modeRevision}`}
      <EpicDrawer
        mode={overlayMode}
        onmode={changeEpicMode}
        slug={page.params.slug ?? ''}
        workspaceId={workspace.id}
        {epicId}
        {canWrite}
        clock={storyClock}
        finished={epicFinished}
        onclose={() => void withoutEpic()}
        onchanged={reloadEpic}
        onstale={() => void invalidate('app:workspace')}
        onremoved={() => void removedEpic()}
      />
    {/key}
  {/if}
{:else if unavailable}
  <NotFoundPage
    slug={page.params.slug ?? ''}
    title={t('workspaceNotFoundTitle', { workspace: t('workspace') })}
    text={t('workspaceNotFoundText', { workspace: t('workspace') })}
  />
{:else}
  <LoadFailed inShell />
{/if}
