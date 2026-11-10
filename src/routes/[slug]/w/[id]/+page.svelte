<script lang="ts">
  import {
    attributeAffectsFilter,
    completedAfterAttributeRead,
    FilteredAttributeReload,
  } from '../../../../lib/attribute-filter-reload.ts';
  import { taskWithSavedAttributes } from '../../../../lib/saved-task-attributes.ts';
  import { onTaskAttributeSaved, type Attribute, type AttributeSaved } from '../../../../lib/task-attributes.svelte.ts';
  import { tick, untrack } from 'svelte';
  import { useShortcut } from '../../../../lib/shortcuts.svelte.ts';
  import { ariaKeyshortcuts, NEW_TASK_KEY } from '../../../../lib/shortcut-keys.ts';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { goto, invalidate, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { navigating, page } from '$app/state';
  import BacklogFilterBar from '../../../../lib/components/BacklogFilterBar.svelte';
  import NarrowDisclosure from '../../../../lib/components/NarrowDisclosure.svelte';
  import CompletedTasks from '../../../../lib/components/CompletedTasks.svelte';
  import EmptyState from '../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import Markdown from '../../../../lib/components/Markdown.svelte';
  import MoveParentDialog from '../../../../lib/components/MoveParentDialog.svelte';
  import PageHead from '../../../../lib/components/PageHead.svelte';
  import TeamExperience from '../../../../lib/components/TeamExperience.svelte';
  import TaskEntry from '../../../../lib/components/TaskEntry.svelte';
  import DraftRow from '../../../../lib/components/DraftRow.svelte';
  import TreeEpic from '../../../../lib/components/TreeEpic.svelte';
  import TreeStory from '../../../../lib/components/TreeStory.svelte';
  import { callOperation, type ApiResult } from '../../../../lib/api.ts';
  import { BacklogDnd } from '../../../../lib/backlog-dnd.svelte.ts';
  import { DropFlash } from '../../../../lib/drop-flash.svelte.ts';
  import { indexTree, ROOT, type DropMove, type DropRow } from '../../../../lib/backlog-drop.ts';
  import {
    emptyFilter,
    filterFromParams,
    filterSearch,
    isFiltering,
    sameFilter,
    type BacklogFilter,
  } from '../../../../lib/backlog-filter.ts';
  import {
    carriesOver,
    keepAddedRow,
    orphanedFromTree,
    parentStoryIds,
    treeStories,
  } from '../../../../lib/added-rows.ts';
  import { MoveQueue } from '../../../../lib/move-queue.ts';
  import {
    backlogTallies,
    pendingBacklogPoints,
    pendingBacklogTasks,
    backlogReadVersion,
    type SavedBacklogPoints,
    type PendingBacklogTask,
  } from '../../../../lib/backlog-tallies.ts';
  import { completionFailureMessage } from '../../../../lib/story-completion.ts';
  import { moveFailureMessage } from '../../../../lib/move-failure.ts';
  import { trackStoryOrder, trackTaskOrder } from '../../../../lib/task-order.ts';
  import { completedMessage } from '../../../../lib/sprint-label.ts';
  import { focusRestored, focusSkipped, removeFromList } from '../../../../lib/task-removal.ts';
  import {
    clearReloadFailure,
    markReloadFailed,
    reloadFailureNote,
    throwIfListFailed,
  } from '../../../../lib/task-reload-failure.svelte.ts';
  import { showToast } from '../../../../lib/toast.svelte.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import { epicCreate, epicMove } from '../../../../shared/operations/epic/index.ts';
  import { epicTitleProblem } from '../../../../shared/epic.ts';
  import { taskTitleProblem, TASK_TITLE_MAX_LENGTH } from '../../../../shared/task.ts';
  import { storyTitleProblem } from '../../../../shared/story.ts';
  import { storyComplete, storyCreate, storyMove, storyReopen } from '../../../../shared/operations/story/index.ts';
  import type { BacklogEpic, BacklogStory, BacklogTask } from '../../../../shared/operations/task/backlog-tree.ts';
  import { taskComplete, taskCreate, taskMove } from '../../../../shared/operations/task/index.ts';
  import type { PageProps } from './$types';

  // ワークスペースの画面（backlog.html の木と起票）。最上段は見本どおり「エピック → 親のないストーリー → 親のないタスク」の3段で、
  // それぞれ position の順。エピックの下にはストーリーを、ストーリーの下には未完了のタスクを並べ、完了したタスクは件数の1行（開くと行を読む折りたたみ）にする。
  // 木の上に絞り込みの帯（BacklogFilterBar）を置く。絞り込みは URL の問い合わせに持ち（replace で履歴を積まない）、load がサーバーで絞った木を読む。
  // 絞っている間は「上へ」「下へ」と Alt と ↑ ↓ を出さず（親を移すは残す）、案内を替える。当たるものが無ければ、木の代わりに無いことと外す操作を出す。
  // 絞っているときに作ったタスク、ストーリー、エピックは、読み直した木に無ければ、絞り込みを外す操作つきのトーストで知らせる。
  // 絞っている間は、つまみのドラッグも出さない（並べ替えは隣を使うため）。完了の折りたたみは、開くと別の操作で20件ずつ読む。
  // 並べ替えは、行の「上へ」「下へ」と Alt と ↑ ↓ で、同じ親（親なしのタスク、親のないストーリー、エピックの下のストーリーはそれぞれの並び）の中で1つ動かす。
  // エピックは親を持たず、画面に出ているエピックの全部（完了と中止したものも含む）の中で動かす（epic-move）。
  // タスクとストーリーの行の「親を移す」は、ダイアログで選んだ親の末尾へ移す。
  // 行の先頭のつまみのドラッグ（BacklogDnd。判定は backlog-drop.ts）は、離れた位置や別の親へ、行の間の線か親の行の囲みに落として動かす。
  // ドラッグの間に木が読み直されたら、そのドラッグは取りやめる。落とした行は、少しのあいだ光らせる。
  // どれも先に画面を動かしてから送り、送る順は守る（MoveQueue）。
  // 失敗したら理由を知らせて読み直す。絞っているときの親の移動は、通った後にも、列が空になってから読み直す（移す先が木に無いことがある）。
  // 動かした並びは読み直すまで画面に持ち、読み直したら捨てる（読み直した値が送った後の並び）。
  // 送り終える前に木が読み直されたら、送り終えた後にもう一度読み直す（捨てた移動があれば知らせる）。
  // 見出しは見本どおり画面の名前（掲示板／バックログ）で、小見出しがワークスペースの名前。見出しの右に、エピックを作るボタン、
  // ストーリーを作るボタンと起票のボタン。見出しの集計の下に、チーム全体の経験値（読めたときだけ）。
  // 閉じていれば、作る操作と完了の操作は出さない（ストーリーの引き出しは読み取り専用で開く。閉じていることはワークスペースの枠の帯が伝える）。
  // ストーリーの題はリンクで、押すと `?story=<ID>` の引き出し（StoryDrawer。+layout.svelte が置く）を開く。開いた行の順は trackStoryOrder が引き出しの前後の移動へ渡す。
  // エピックの行の題はエピックの画面へのリンクで、エピックを直すダイアログはその画面の見出しの横から開く（ここのダイアログは作るだけ）。
  // 完了にしたタスクの行は、読み直すまで完了の印を付けてその場に残し、その行のポイントを親の「完了」に即時に足す。折りたたみの件数は読み直した値なので、その行は読み直すまで入らない。
  // ストーリーの「完了にする」は、配下の未完了のタスク（画面で完了にした行は数えない）が残るあいだは押せない。完了と取り消しは、通ったら木を読み直す。
  // 起票したタスクは、読み直さずに親の配下（親なしなら一覧の末尾）に足し、親の「全体」のポイントにも足す。親の行が畳まれていれば開く。
  // 足した行は、読み直した木に入るか、作った後に始まった読み直しの木に無い（別の人の削除など）と外す。
  // ただし絞っているときは、末尾に足さずに木を読み直す（上の帯の段落）。
  // ダイアログでエピックとストーリーを作ったときは、木を読み直す（空の行で作ったときは、読み直さずに木へ足す）。
  // 完了の操作を送っている最中の行（pendingIds、storyPending）は、読み直しでは捨てず、応答が来たら外す。
  // 見出しの下に、ワークスペースの完成の定義（枠の値。空なら出さない）を畳んで1つだけ置く
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const tree = $derived(data.tree);
  // 行の「⋯」から消した（戻した）後の読み直しの失敗の印（#979。task-reload-failure.svelte.ts）。木が読めたら下ろす
  $effect(() => {
    if (tree !== null) untrack(clearReloadFailure);
  });
  // 木を読んだときの絞り込み（URL の問い合わせ）。絞っている間は並べ替え（上へ、下へ、Alt と ↑ ↓）を出さない
  const filter = $derived(data.filter);
  const filtering = $derived(isFiltering(filter));
  // 絞り込みの値を変えて読み直している間（同じ画面の中で、絞り込みの値が変わる移動。`?task=` だけの移動は含めない）。
  // 前の木を残したまま、木を aria-busy にする（components.css が少し薄くする）
  const reloading = $derived.by(() => {
    const target = navigating.to;
    if (target === null || target.url.pathname !== page.url.pathname) return false;
    return !sameFilter(filterFromParams(target.url.searchParams), filter);
  });
  // 行のリンクの問い合わせ（今の絞り込みを残して task を足す）。行ごとに作らず、ここで1回だけ組み、行は task の値だけを足す
  // タスク、ストーリー、エピックの引き出しは同時に開かないので、開くリンクは、もう一方の問い合わせを外す
  function queryBase(key: 'task' | 'story' | 'epic_id'): string {
    const query = new SvelteURLSearchParams(page.url.search);
    query.delete('task');
    query.delete('story');
    query.delete('epic_id');
    const rest = query.toString();
    return rest === '' ? `?${key}=` : `?${rest}&${key}=`;
  }
  const taskQueryBase = $derived(queryBase('task'));
  // ストーリーの題のリンク（今の絞り込みを残して story を足す）。引き出しの前に、行の ID だけを足せば済むよう、経路まで含める
  const storyHrefBase = $derived(
    `${resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: page.params.id ?? '' })}${queryBase('story')}`,
  );
  // エピックの題のリンク（今の絞り込みを残して epic を足す）
  const epicHrefBase = $derived(
    `${resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: page.params.id ?? '' })}${queryBase('epic_id')}`,
  );
  // 親のない完了の件数。絞っているときは返らない（null）ので 0 として扱い、折りたたみの1行を出さない
  const rootDone = $derived(tree?.completed_count ?? 0);
  // 絞り込みの結果の読み上げ（出したタスクの行の数か、当たるものが無いこと）。絞っていなければ空
  const filterResult = $derived.by(() => {
    if (!filtering || tree === null) return '';
    // 描かれる行だけ数える。親を移した先が木に無いストーリーなら、行は taskLists に入っても描かれない
    const drawn = new Set<string>([ROOT, ...loadedStories.map(({ row: story }) => story.id)]);
    const rows = Object.entries(taskLists).reduce((sum, [key, list]) => sum + (drawn.has(key) ? list.length : 0), 0);
    const none = epics.length === 0 && tree.stories.length === 0 && rows === 0;
    return none ? t('filterResultNone') : t('filterResultCount', { count: rows });
  });
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // `c` で、親なしのタスクの空の行（木の末尾）へフォーカスを移す。行が無い（書き込めない、木を読み込み中）間は働かない
  // bind:this は、部品が外れると null に戻る
  let rootTaskRow = $state<DraftRow | null>();
  useShortcut(() => ({
    id: 'backlog-new-task',
    keys: NEW_TASK_KEY,
    label: () => t('shortcutNewTask', { task: t('task') }),
    enabled: () => rootTaskRow != null,
    run: () => rootTaskRow?.focus(),
  }));
  // 完成の定義の畳みを開いたか。開くまで本文を描かない
  let dodOpen = $state(false);
  // 期日の印を決める、ワークスペースの今日の日付と週の始まり（API の値）
  const clock = $derived({ today: tree?.today ?? '', weekStart: tree?.week_start ?? 1 });

  // 読み直したら（枠の読み直し、ワークスペースの切り替え）、木に入った足した行と、完了の印と、画面で動かした並びを捨てる
  // at は足した時刻（performance.now()）。木の loadedAt（読み直しを始めた時刻）がこれより後なら、その木は足した行を含むはず
  // fromTree は、木にもとからあった行を完了にして写したもの（親の合計は、木が持つ分に含まれるので足さない）
  let added = $state<{ task: BacklogTask; storyId: string | null; at: number; fromTree?: true }[]>([]);
  // 絞り込み中の起票は木へ直接出さず、全体の件数だけに足す。次の読み直しが起票を含めば捨てる。
  let tallyAdded = $state<PendingBacklogTask[]>([]);
  let addedFor: string | undefined;
  // 前の読み込みで要求した絞り込み（読み込みに失敗した読み直しも含む）。絞り込みの条件が替わったときだけ、印と行を持ち越さない（carriesOver）
  let loadedFilter: typeof filter | undefined;
  function inTree(loaded: typeof tree, id: string): boolean {
    if (loaded === null) return false;
    const stories = treeStories(loaded);
    return (
      loaded.tasks.some((task) => task.id === id) || stories.some((story) => story.tasks.some((row) => row.id === id))
    );
  }
  // 空の行で作ったエピックとストーリー。読み直さずに木へ足し、読み直した木に入ったら捨てる（タスクの added と同じ考え方）
  let addedEpics = $state<{ epic: BacklogEpic; at: number }[]>([]);
  let addedStories = $state<{ story: BacklogStory; epicId: string | null; at: number }[]>([]);
  // 作った行だけ一度光らせる。DND の光とは別の状態なので、絞り込み中の追加にも使える。
  const createdFlash = new DropFlash<{ kind: 'task' | 'story' | 'epic'; id: string }>();
  function wasAdded(kind: 'task' | 'story' | 'epic', id: string): boolean {
    return createdFlash.value?.kind === kind && createdFlash.value.id === id;
  }
  $effect(() => {
    void page.params.id;
    return () => createdFlash.clear();
  });
  let completedIds = $state<string[]>([]);
  let savedPoints = $state<SavedBacklogPoints>({});
  let savedAttributes = $state<Record<string, Partial<Record<Attribute, AttributeSaved>>>>({});
  $effect(() => {
    const slug = page.params.slug;
    const workspaceId = page.params.id;
    return onTaskAttributeSaved((saved) => {
      if (saved.slug !== slug || saved.workspaceId !== workspaceId) return;
      savedAttributes = {
        ...savedAttributes,
        [saved.taskId]: { ...savedAttributes[saved.taskId], [saved.field]: saved },
      };
      if (saved.field === 'points')
        savedPoints = { ...savedPoints, [saved.taskId]: { value: saved.task.points, at: saved.at } };
      if (attributeAffectsFilter(saved.field, filter)) {
        const savedFilter = filter;
        void attributeReload
          .request(() => page.params.id === workspaceId && sameFilter(filter, savedFilter))
          .catch(() => showToast(t('taskListReloadFailed'), 'alert'));
      }
    });
  });
  let movedRootCategories = $state<Record<string, { value: BacklogTask['category']; at: number }>>({});
  function savedRow(task: BacklogTask): BacklogTask {
    const parentId = taskPlaces[task.id]?.parentId;
    const parent =
      parentId == null
        ? undefined
        : (openStories.find((row) => row.id === parentId) ?? allStories.find((row) => row.id === parentId));
    const inherited = parentId == null ? undefined : (parentEpicOf(parentId)?.category ?? parent?.category ?? null);
    return taskWithSavedAttributes(task, savedAttributes[task.id] ?? {}, inherited, movedRootCategories[task.id]);
  }
  function rememberCategoryForMove(task: BacklogTask, parentId: string | null): void {
    if (parentId === null) movedRootCategories[task.id] = { value: savedRow(task).category, at: performance.now() };
    else delete movedRootCategories[task.id];
  }

  // 完了の応答が返った時刻（performance.now()）。これより前に始まった読み直しが遅れて届いても、完了の印を捨てない（completionSettled）
  let completedAt: Record<string, number> = {};
  let pendingIds = $state<string[]>([]);
  // 完了か取り消しを送っている最中のストーリーと、送っている操作
  let storyPending = $state<Record<string, 'complete' | 'reopen'>>({});
  // 画面で親を移したタスク（値は移す先の親。null は親なし）と、並べ替えた親ごとの id の並び（キーは親の ID か ROOT）。
  // ストーリーも同じ形で持つ（親はエピック）
  let movedParents = $state<Record<string, string | null>>({});
  let taskOrders = $state<Record<string, string[]>>({});
  let movedStoryParents = $state<Record<string, string | null>>({});
  let storyOrders = $state<Record<string, string[]>>({});
  // 画面で並べ替えたエピックの id の並び（並べ替えていなければ null）
  let epicOrder = $state<string[] | null>(null);
  // 動かす操作は、押した順に1つずつ送る（src/lib/move-queue.ts）。読み直したら、まだ送っていない古い操作は捨てる
  const moves = new MoveQueue<ApiResult<unknown>>({
    // 列が空になった後の読み直し。親を移した行が木から消えてフォーカスを失っていれば、見出しへ移す
    reload: async () => {
      const saved = focusedControl();
      const lost = document.activeElement === null || document.activeElement === document.body;
      await reloadTree();
      await restoreFocus(saved, lost);
    },
    dropped: () => showToast(t('moveReloaded'), 'alert'),
  });
  const attributeReload = new FilteredAttributeReload({
    whenIdle: () => moves.whenIdle(),
    reload: async () => {
      const saved = focusedControl();
      const lost = document.activeElement === null || document.activeElement === document.body;
      await invalidate('app:backlog-tree');
      await tick();
      await restoreFocus(saved, lost);
    },
  });
  $effect.pre(() => {
    // 足した行は、読み直した木に入るまで残す。作る前に読んだ木が遅れて届いても、作った行を消さないため。
    // 作った後に始まった読み直しの木に無い行（別の人の削除、親ごとの消失）は、木に入る日が来ないので捨てる
    // ワークスペースを替えたときと、絞り込みの条件を替えて読んだときも、木に入らない行が残り続けるので捨てる
    const loaded = tree;
    const workspaceId = page.params.id;
    const sameWorkspace = untrack(() => addedFor) === workspaceId;
    addedFor = workspaceId;
    const carry = carriesOver(
      untrack(() => loadedFilter),
      filter,
      sameWorkspace,
    );
    loadedFilter = filter;
    // 完了にした行は、読み直した木（未完了のタスクだけを返す）に無いので、木に入るのを待たずに捨てる。残すと完了の印を捨てた後に未完了で戻る
    const done = untrack(() => completedIds);
    const loadedAtForDone = untrack(() => data.loadedAt);
    // 完了の応答より前に始まった読み直しの木は、完了を含むとは限らない。その行は木に無くても捨てず、印も残す
    const unsettled = completedAfterAttributeRead(done, completedAt, loadedAtForDone, attributeReload.preservesState);
    // 木に無い行を残すかは、足した時刻と読み直しを始めた時刻で決める（src/lib/added-rows.ts）
    const loadedAt = untrack(() => data.loadedAt);
    savedAttributes = carry
      ? Object.fromEntries(
          Object.entries(untrack(() => savedAttributes)).map(([id, fields]) => [
            id,
            Object.fromEntries(Object.entries(fields).filter(([, saved]) => loaded === null || saved.at >= loadedAt)),
          ]),
        )
      : {};
    savedPoints = carry
      ? pendingBacklogPoints(
          untrack(() => savedPoints),
          loadedAt,
          loaded !== null,
        )
      : {};
    const keepRow = (at: number, inLoaded: boolean) =>
      carry &&
      keepAddedRow({ at }, { inLoadedTree: inLoaded, completed: false, treeLoaded: loaded !== null, loadedAt });
    tallyAdded = sameWorkspace
      ? pendingBacklogTasks(
          untrack(() => tallyAdded),
          untrack(() => data.readVersion),
          loaded !== null,
        )
      : [];
    const loadedStoryIds = (loaded === null ? [] : treeStories(loaded)).map((story) => story.id);
    // 画面で足したストーリーのうち、この回で残すもの。孤立の判定にも、捨てるものを含めない
    const keptStories = untrack(() => addedStories).filter((entry) =>
      keepRow(entry.at, loadedStoryIds.includes(entry.story.id)),
    );
    // 絞り込み中は、当たるタスクが唯一だった親が、その完了で木から外れる。遅れて届いた木で、写した行（fromTree）の親が木に無ければ、
    // 行はどの親の下にも描かれず件数だけに数えられるので、印と一緒に捨てる（親ごと外れる競合の無い読み直しと同じ結果）
    const storyIdsLoaded = parentStoryIds(
      loadedStoryIds,
      keptStories.map((entry) => entry.story.id),
    );
    const orphaned = (entry: { task: BacklogTask; storyId: string | null; fromTree?: true }) =>
      orphanedFromTree(entry, {
        treeLoaded: loaded !== null,
        storyIds: storyIdsLoaded,
        taskInTree: inTree(loaded, entry.task.id),
      });
    const orphanIds = untrack(() => added)
      .filter(orphaned)
      .map((entry) => entry.task.id);
    added = carry
      ? untrack(() => added).filter(
          (entry) =>
            !orphaned(entry) &&
            (unsettled.includes(entry.task.id) ||
              keepAddedRow(entry, {
                inLoadedTree: inTree(loaded, entry.task.id),
                completed: done.includes(entry.task.id),
                treeLoaded: loaded !== null,
                loadedAt,
              })),
        )
      : [];
    addedEpics = untrack(() => addedEpics).filter((entry) =>
      keepRow(entry.at, loaded?.epics.some((epic) => epic.id === entry.epic.id) ?? false),
    );
    addedStories = keptStories;
    const keptDone = carry ? unsettled.filter((id) => !orphanIds.includes(id)) : [];
    completedIds = keptDone;
    completedAt = Object.fromEntries(keptDone.map((id) => [id, completedAt[id]]));
    const preserveMoves = carry && attributeReload.preservesState;
    if (!preserveMoves) {
      movedRootCategories = {};
      movedParents = {};
      taskOrders = {};
      movedStoryParents = {};
      storyOrders = {};
      epicOrder = null;
    }
    moves.reloaded(preserveMoves);
  });

  // order の順に並べる。order に無い行（後から足した行）は、元の順のまま後ろに置く
  function sortedBy<T extends { id: string }>(rows: readonly T[], order: readonly string[]): T[] {
    const rank = new Map(order.map((id, index) => [id, index]));
    const rankOf = (row: T, index: number) => rank.get(row.id) ?? order.length + index;
    return rows
      .map((row, index) => ({ row, rank: rankOf(row, index) }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.row);
  }

  // 親ごとの行（キーは親の ID か ROOT）。画面で親を移した行は移す先に置き、並べ替えた親はその並びに従う
  function grouped<T extends { id: string }>(
    rows: readonly { row: T; parentId: string | null }[],
    moved: Record<string, string | null>,
    orders: Record<string, string[]>,
  ): Record<string, T[]> {
    const lists: Record<string, T[]> = {};
    const seen: Record<string, true> = {};
    for (const { row, parentId } of rows) {
      // 読み直した一覧と足した行が重なっても（起票の直後に読み直したときなど）、同じ id の行は1つにする
      if (seen[row.id]) continue;
      seen[row.id] = true;
      const target = Object.hasOwn(moved, row.id) ? (moved[row.id] ?? null) : parentId;
      (lists[target ?? ROOT] ??= []).push(row);
    }
    for (const [key, list] of Object.entries(lists)) {
      const order = orders[key];
      if (order !== undefined) lists[key] = sortedBy(list, order);
    }
    return lists;
  }

  // 親ごとの行の、親と並びの中の位置。上へ、下へのボタンの端の判定と、親を移すダイアログの今の親に使う
  function placesOf<T extends { id: string }>(lists: Record<string, T[]>) {
    const places: Record<string, { parentId: string | null; index: number; count: number }> = {};
    for (const [key, list] of Object.entries(lists)) {
      list.forEach((row, index) => {
        places[row.id] = { parentId: key === ROOT ? null : key, index, count: list.length };
      });
    }
    return places;
  }

  // エピックは、画面で並べ替えた並びがあればそれに従う
  // 空の行で足したエピックは、読み直した木に入るまで末尾に置く
  const treeEpics = $derived([
    ...(tree?.epics ?? []),
    ...addedEpics.filter((entry) => !(tree?.epics ?? []).some((epic) => epic.id === entry.epic.id)).map((e) => e.epic),
  ]);
  const epics = $derived(epicOrder === null ? treeEpics : sortedBy(treeEpics, epicOrder));
  const epicIds = $derived(epics.map((epic) => epic.id));
  // 読み直した木のストーリー（エピックの下のものと親のないもの）と、その親
  const loadedStories = $derived([
    ...epics.flatMap((epic) => epic.stories.map((story) => ({ row: story, parentId: epic.id as string | null }))),
    ...(tree?.stories ?? []).map((story) => ({ row: story, parentId: null })),
    ...addedStories.map((entry) => ({ row: entry.story, parentId: entry.epicId })),
  ]);
  const storyLists = $derived(grouped(loadedStories, movedStoryParents, storyOrders));
  const storyPlaces = $derived(placesOf(storyLists));
  const rootStoryList = $derived(storyLists[ROOT] ?? []);
  // 木の順（エピックの下、親のないものの順）に並べたストーリー
  const allStories = $derived([...epics.flatMap((epic) => storyLists[epic.id] ?? []), ...rootStoryList]);
  // 今その下に並んでいる、ストーリーの親のエピック。親なしなら undefined
  function parentEpicOf(storyId: string): BacklogEpic | undefined {
    const epicId = storyPlaces[storyId]?.parentId;
    return epicId == null ? undefined : epics.find((epic) => epic.id === epicId);
  }
  // タスクの親に選べるストーリー（完了していないもの）。選択欄は親のエピック（親なしは null）でまとめる。
  // ストーリーの親に選べるエピック（完了も中止もしていないもの）
  // 絞っているときは、木から消えたものも選べるよう、API の choices（全部のエピックと、完了していないストーリー）から作る
  // （画面で親を移したストーリーは、移す先のエピックの下にまとめる）
  const choiceEpics = $derived(tree?.choices.epics ?? []);
  const openStories = $derived.by(() => {
    const choices = tree?.choices.stories;
    if (choices == null) {
      return allStories
        .filter((story) => story.completed_at === null)
        .map((story) => {
          const epic = parentEpicOf(story.id);
          return {
            id: story.id,
            title: story.title,
            group: epic === undefined ? null : { id: epic.id, title: epic.title },
            // 起票のダイアログで、この親を選んだときに引き継ぐ区分
            category: story.category,
          };
        });
    }
    return choices.map((story) => {
      const epicId = Object.hasOwn(movedStoryParents, story.id) ? movedStoryParents[story.id] : story.epic_id;
      const epic = epicId == null ? undefined : choiceEpics.find((candidate) => candidate.id === epicId);
      return {
        id: story.id,
        title: story.title,
        group: epic === undefined ? null : { id: epic.id, title: epic.title },
        category: story.category,
      };
    });
  });
  // 空の行で作ったエピックは、読み直すまで choices に無いので、画面に足した分も親の候補に入れる
  const openEpics = $derived([
    ...choiceEpics.filter((epic) => !epic.finished).map((epic) => ({ id: epic.id, title: epic.title })),
    ...addedEpics
      .filter((entry) => !choiceEpics.some((epic) => epic.id === entry.epic.id))
      .map((entry) => ({ id: entry.epic.id, title: entry.epic.title })),
  ]);

  const taskLists = $derived(
    grouped(
      [
        ...loadedStories.flatMap(({ row: story }) => story.tasks.map((task) => ({ row: task, parentId: story.id }))),
        ...(tree?.tasks ?? []).map((task) => ({ row: task, parentId: null })),
        ...added.map((entry) => ({ row: entry.task, parentId: entry.storyId })),
      ],
      movedParents,
      taskOrders,
    ),
  );
  const taskPlaces = $derived(placesOf(taskLists));
  const rootRows = $derived(taskLists[ROOT] ?? []);

  // 絞り込みに左右されない全体の件数に、画面で起票・完了・見積もりした分を足し引きする。
  const tallies = $derived(
    backlogTallies(
      tree ?? { open_count: 0, unfilled_count: 0, unestimated_count: 0, unscheduled_count: 0 },
      tree === null ? [] : [...treeStories(tree).flatMap((story) => story.tasks), ...tree.tasks],
      [...added, ...tallyAdded].map((entry) => entry.task),
      completedIds,
      savedPoints,
    ),
  );

  // ドラッグの判定に渡す、今の木の並び（画面で動かした並びを含む）
  const dropIndex = $derived(
    indexTree({
      epics: epicIds,
      openEpics: openEpics.map((epic) => epic.id),
      storyLists: Object.fromEntries(
        Object.entries(storyLists).map(([key, list]) => [
          key,
          list.map((story) => ({ id: story.id, open: story.completed_at === null })),
        ]),
      ),
      taskLists: Object.fromEntries(Object.entries(taskLists).map(([key, list]) => [key, list.map((task) => task.id)])),
      completedTasks: completedIds,
    }),
  );
  const dnd = new BacklogDnd({
    index: () => dropIndex,
    enabled: () => canWrite && !filtering,
    onDrop: (drop) => {
      if (drop.move.kind === 'task') dropTask(drop.move);
      else if (drop.move.kind === 'story') dropStory(drop.move);
      else dropEpic(drop.move);
    },
    onStale: () => showToast(t('moveReloaded'), 'alert'),
  });
  // 木の行へ渡す。書き込めないときと、絞っている間（並べ替えは隣を使うため）は渡さず、つまみも落とし先も出さない
  const rowDnd = $derived(canWrite && !filtering ? dnd : undefined);
  $effect(() => dnd.monitor());
  // 読み直したら、つかんでいるドラッグは取りやめる（離しても何も送らない）。印と光らせる行も捨てる
  $effect.pre(() => {
    void tree;
    dnd.reset();
  });
  // 親なしのタスクの折りたたみの行は、親なしの末尾の落とし先
  const rootTail: DropRow = { kind: 'tail', parent: 'root', id: ROOT };
  // 親なしの段が空のとき、行をつかんでいる間だけ出す落とし先（親なしのタスクと、親のないストーリーそれぞれ）
  const taskSlot: DropRow = { kind: 'slot', parent: 'task-root' };
  const storySlot: DropRow = { kind: 'slot', parent: 'story-root' };

  function storyRows(story: BacklogStory): BacklogTask[] {
    return taskLists[story.id] ?? [];
  }

  // 配下の未完了のタスクの件数。画面で完了にした行は数えない（読み直すまで行は残るが、完了している）。
  // 絞り込みで出していない未完了の行（open_task_count のうち木に載らなかった分）も数える
  function remainingOf(story: BacklogStory): number {
    const hidden = Math.max(0, story.open_task_count - story.tasks.length);
    return hidden + storyRows(story).filter((task) => !completedIds.includes(task.id)).length;
  }

  const fromTreeIds = $derived(new Set(added.filter((entry) => entry.fromTree).map((entry) => entry.task.id)));

  // 親の「全体」のポイント。足した行と、画面で移してきた行の分を足し、画面で外へ移した行の分を引く
  function pointsAllOf(story: BacklogStory): number {
    const rows = storyRows(story);
    const known = new Set(story.tasks.map((task) => task.id));
    const here = new Set(rows.map((task) => task.id));
    const gained = rows.filter((task) => !known.has(task.id) && !fromTreeIds.has(task.id));
    const lost = story.tasks.filter((task) => !here.has(task.id));
    const sum = (tasks: readonly BacklogTask[]) => tasks.reduce((total, task) => total + (task.points ?? 0), 0);
    const changed = rows.filter((task) => known.has(task.id));
    const delta = changed.reduce((total, task) => total + (savedRow(task).points ?? 0) - (task.points ?? 0), 0);
    return (
      story.points_all + gained.reduce((total, task) => total + (savedRow(task).points ?? 0), 0) - sum(lost) + delta
    );
  }

  // 完了にした行のポイントを、親の「完了」に足す。完了にした行は、読み直した一覧では未完了だった行か、足した行なので、
  // 読み直した「完了」の合計には入っていない
  function pointsDoneOf(story: BacklogStory): number {
    // 木に無い、もとから木にあった行は、完了を含む木が持つ「完了」の合計に入っているので足さない
    const known = new Set(story.tasks.map((task) => task.id));
    const done = storyRows(story).filter(
      (task) => completedIds.includes(task.id) && (known.has(task.id) || !fromTreeIds.has(task.id)),
    );
    return story.points_done + done.reduce((sum, task) => sum + (savedRow(task).points ?? 0), 0);
  }

  // エピックの合計は、今その下に並ぶストーリーの合計（画面で移したストーリーと、足した行、完了にした行の分を含む）に、
  // 絞り込みで出していないストーリーの分（API の合計から、読み直した木のストーリーの分を引いた残り。絞っていなければ 0）を足す
  function epicStories(epic: BacklogEpic): BacklogStory[] {
    return storyLists[epic.id] ?? [];
  }
  function epicPoints(epic: BacklogEpic): { done: number; all: number } {
    const stories = epicStories(epic);
    const hiddenDone = epic.points_done - epic.stories.reduce((sum, story) => sum + story.points_done, 0);
    const hiddenAll = epic.points_all - epic.stories.reduce((sum, story) => sum + story.points_all, 0);
    return {
      done: hiddenDone + stories.reduce((sum, story) => sum + pointsDoneOf(story), 0),
      all: hiddenAll + stories.reduce((sum, story) => sum + pointsAllOf(story), 0),
    };
  }

  // 送っている操作の読み上げ。タスクの完了、ストーリーの完了、ストーリーの取り消しの順に、送っているものを1つ選ぶ
  const completingStatus = $derived.by(() => {
    const storyActions = Object.values(storyPending);
    if (pendingIds.length > 0) return t('taskCompleting', { done: t('done') });
    if (storyActions.includes('complete')) return t('storyCompleting', { done: t('done') });
    if (storyActions.includes('reopen')) return t('storyReopening', { done: t('done') });
    return '';
  });
  // 完了にした行の完了の印へフォーカスを移すために持つ。読むのは操作の後の処理の中だけ。
  // bind:this で行ごとに書き込むので $state にする（ただの入れ物だと開発時に binding_property_non_reactive が出る）
  const entries = $state<Record<string, ReturnType<typeof TaskEntry> | null | undefined>>({});
  // ストーリーとエピックの行。起票した親の行を開く、完了の後にフォーカスを戻すために持つ
  const treeRows = $state<Record<string, ReturnType<typeof TreeStory> | null | undefined>>({});
  const epicRows = $state<Record<string, ReturnType<typeof TreeEpic> | null | undefined>>({});

  // ストーリーの行と、その親のエピックの行を開く
  function expandStory(storyId: string): void {
    treeRows[storyId]?.expand();
    const epicId = storyPlaces[storyId]?.parentId;
    if (epicId != null) epicRows[epicId]?.expand();
  }

  // 行の「⋯」の「この<タスク>を削除する」。確認は挟まず、消したら「取り消す」付きのトーストを出して木を読み直す。
  // フォーカスの移し方は引き出しの削除と同じ（task-removal.ts）。キーボードで選んだときだけ「取り消す」へ移し、
  // 取り消した後は戻した行の題のリンクへ、Esc で閉じたときは消した行の次の行（無ければ前の行、無ければ見出し）へ移す
  async function removeTask(task: BacklogTask, keyboard: boolean): Promise<void> {
    if (workspace === null || !canWrite) return;
    // 送っている並べ替えと親の移動が終わってから読み直す（先に読み直すと、まだ送っていない移動が捨てられ、並びが一時的に戻る）
    const reload = async (): Promise<void> => {
      await moves.whenIdle();
      await invalidate('app:backlog-tree');
      await throwIfListFailed(() => page.data);
    };
    const workspaceId = workspace.id;
    await removeFromList({
      slug: page.params.slug ?? '',
      workspaceId: workspace.id,
      taskId: task.id,
      title: task.title,
      keyboard,
      reload,
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路から task などの問い合わせを外しただけ
      closeDrawer: (path) => goto(path, { replace: true, reset: false }),
      onstale: () => void invalidateAll(),
      onrestored: async (restoredId, focus) => {
        await reload();
        await focusRestored(restoredId, focus);
      },
      onskipped: focusSkipped,
      onreloadfailed: (failure) => markReloadFailed(failure, workspaceId),
    });
  }

  async function complete(task: BacklogTask): Promise<void> {
    if (workspace === null || pendingIds.includes(task.id)) return;
    pendingIds = [...pendingIds, task.id];
    const workspaceId = workspace.id;
    try {
      const result = await callOperation(
        taskComplete,
        { workspace_id: workspaceId, task_id: task.id },
        { slug: page.params.slug ?? '' },
      );
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (workspaceId !== page.params.id) return;
      if (result.ok || (result.status === 409 && result.error?.code === 'conflict')) {
        completedIds = [...completedIds, task.id];
        completedAt[task.id] = performance.now();
        // 木にもとからあった行は、遅れて届く古い木に無くても残すため、足した行と同じ入れ物に写す（画面で足した行はすでにある）
        // 木から消えた行（親が引けない）は写さない。親なしの行として現れるため
        if (taskPlaces[task.id] !== undefined && !added.some((entry) => entry.task.id === task.id)) {
          added = [
            ...added,
            { task, storyId: taskPlaces[task.id]?.parentId ?? null, at: performance.now(), fromTree: true },
          ];
        }
        // 別の画面で先に完了にされていたときは、同じ完了の印で示し、知らせる
        showToast(
          result.ok
            ? completedMessage(result.data.left_sprint, result.data.xp_granted, t)
            : t('taskAlreadyDone', { task: t('task'), done: t('done') }),
          'check',
        );
        // 押したボタンは完了の印に替わって消えるので、フォーカスを印へ移す
        await tick();
        entries[task.id]?.focusMark();
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        // タスクが消えている。木を読み直して、行を外す
        showToast(t('taskGone', { task: t('task') }), 'alert');
        await invalidateAll();
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        // 閉じた。読み直して、閉じた表示（作る操作と完了の操作を出さない）に切り替える
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        await invalidateAll();
      } else {
        showToast(t('taskCompleteFailed', { done: t('done') }), 'alert');
      }
    } finally {
      pendingIds = pendingIds.filter((id) => id !== task.id);
    }
  }

  // ストーリーを完了にする、取り消す。通ったら木を読み直し、作り直した行の操作（取り消すか完了にする）へフォーカスを移す
  async function setStoryCompletion(story: BacklogStory, action: 'complete' | 'reopen'): Promise<void> {
    if (workspace === null || Object.hasOwn(storyPending, story.id)) return;
    storyPending = { ...storyPending, [story.id]: action };
    const workspaceId = workspace.id;
    try {
      const input = { workspace_id: workspaceId, story_id: story.id };
      const options = { slug: page.params.slug ?? '' };
      const result =
        action === 'complete'
          ? await callOperation(storyComplete, input, options)
          : await callOperation(storyReopen, input, options);
      if (workspaceId !== page.params.id) return;
      if (!result.ok && result.status === 401) {
        await invalidateAll();
        return;
      }
      if (result.ok) {
        showToast(
          action === 'complete'
            ? t('storyCompleted', { story: t('story'), done: t('done') })
            : t('storyReopened', { story: t('story'), done: t('done') }),
          'check',
        );
      } else {
        const failure = completionFailureMessage(result, action);
        showToast(failure.message, 'alert');
        if (!failure.reload) return;
      }
      await invalidateAll();
      await tick();
      // 行が消えていたら（読み直した木に無ければ）、見出しへ移す
      const row = treeRows[story.id];
      if (row) row.focusCompletion();
      else document.querySelector<HTMLElement>('h1.page-title')?.focus();
    } finally {
      storyPending = Object.fromEntries(Object.entries(storyPending).filter(([id]) => id !== story.id));
    }
  }

  // 絞り込みの帯の値を URL の問い合わせに書き、木を読み直す（load が問い合わせを読んで backlog-tree に渡す）。
  // 履歴は積まない。フォーカスとスクロールの位置は動かさない。読み直している間は前の木を残し、続けて変えたら古い読み直しは捨てる（SvelteKit の移動）
  // 前の移動がまだ終わっていない間に値を元に戻すこともあるので、今の URL と同じでも省かず、最後の操作の行き先へ必ず移る
  function applyFilter(next: BacklogFilter): Promise<void> {
    const search = filterSearch(page.url.search, next);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、絞り込みの問い合わせだけを替えている
    return goto(page.url.pathname + search, { replace: true, reset: false });
  }

  // 当たるものが無いときの「絞り込みを外す」。押したボタンは消えるので、外した後は検索の欄へフォーカスを移す
  async function clearFilter(): Promise<void> {
    await applyFilter(emptyFilter);
    await tick();
    document.querySelector<HTMLElement>('.toolbar input[type="search"]')?.focus();
  }

  // 読み直した木に、その行があるか
  function treeHas(kind: 'task' | 'story' | 'epic', id: string): boolean {
    const loaded = data.tree;
    if (loaded === null) return true;
    const stories = treeStories(loaded);
    if (kind === 'epic') return loaded.epics.some((epic) => epic.id === id);
    if (kind === 'story') return stories.some((story) => story.id === id);
    return (
      loaded.tasks.some((task) => task.id === id) || stories.some((story) => story.tasks.some((row) => row.id === id))
    );
  }

  // 絞っているときに作ったものを、読み直した木で探す。あれば作ったことを知らせ（ダイアログは、絞っている間は作った知らせを出さない）、
  // 無ければ（絞り込みに当たらなければ）、作った知らせの代わりに「表示していません」を、絞り込みを外す操作と一緒に知らせる
  async function revealOrNotice(kind: 'task' | 'story' | 'epic', id: string, createdMessage: string): Promise<boolean> {
    await tick();
    if (data.tree === null || treeHas(kind, id)) {
      showToast(createdMessage, 'check');
      return true;
    }
    showToast(t('filterHiddenCreated'), 'check', { label: t('filterClear'), run: () => void clearFilter() });
    return false;
  }

  async function created(task: BacklogTask, storyId: string | null): Promise<void> {
    // 絞っているときは、足した行が絞り込みに当たるかを画面では決めないので、木を読み直す
    if (filtering) {
      tallyAdded = [...tallyAdded, { task, afterRead: backlogReadVersion() }];
      const parent = storyId === null ? undefined : openStories.find((story) => story.id === storyId);
      const message =
        parent === undefined
          ? t('taskCreated', { backlog: t('backlog') })
          : t('taskCreatedUnder', { story: t('story'), title: parent.title });
      await invalidate('app:backlog-tree');
      if (await revealOrNotice('task', task.id, message)) {
        if (storyId !== null) expandStory(storyId);
        createdFlash.show({ kind: 'task', id: task.id });
      }
      return;
    }
    added = [...added, { task, storyId, at: performance.now() }];
    // 畳まれている親の行は開いて、足した行が見えるようにする
    if (storyId !== null) expandStory(storyId);
    createdFlash.show({ kind: 'task', id: task.id });
  }

  // エピックかストーリーを作った。木を読み直し、絞っているときに作ったものを知らせる
  async function saved(kind: 'story' | 'epic', createdId: string | null): Promise<void> {
    const wasFiltering = filtering;
    await invalidateAll();
    if (createdId === null) return;
    const message = kind === 'story' ? t('storyCreated', { story: t('story') }) : t('epicCreated', { epic: t('epic') });
    if (!wasFiltering || (await revealOrNotice(kind, createdId, message))) createdFlash.show({ kind, id: createdId });
  }

  // 空の行の題の検査（画面の検査は API の検証と同じ判定。空は送らないので required は出ない）
  function rowTitleProblem(kind: 'epic' | 'story', title: string): string | null {
    const problem = kind === 'epic' ? epicTitleProblem(title) : storyTitleProblem(title);
    if (problem === null) return null;
    const key = kind === 'epic' ? 'epic' : 'story';
    if (problem === 'too_long') return t(`${key}TitleTooLong`, { max: 200 });
    if (problem === 'invalid_character') return t(`${key}TitleInvalidCharacter`);
    return t(`${key}TitleRequired`);
  }

  // 空の行でエピックを作る。作れたら読み直さずに木の末尾へ足す。絞っているときは木を読み直し、作ったものを知らせる。
  // 返すのは、空の行に出すエラーの文（成功は null）
  async function addEpicRow(title: string): Promise<string | null> {
    if (workspace === null) return t('epicCreateFailed');
    const sentFor = page.params.id;
    const result = await callOperation(
      epicCreate,
      { workspace_id: workspace.id, title },
      { slug: page.params.slug ?? '' },
    );
    // 送っている間に別のワークスペースへ移っていたら、成功も失敗も、古い応答で状態を触らない
    if (sentFor !== page.params.id) return null;
    if (!result.ok) {
      if (result.status === 401) {
        await invalidateAll();
        return t('epicCreateFailed');
      }
      if (result.status === 409 && result.error?.code === 'workspace_closed') {
        void invalidateAll();
        return t('workspaceClosedReadOnly', { workspace: t('workspace') });
      }
      return t('epicCreateFailed');
    }
    const made = result.data.epic;
    if (filtering) {
      await saved('epic', made.id);
      return null;
    }
    addedEpics = [
      ...addedEpics,
      {
        epic: {
          id: made.id,
          title: made.title,
          due_on: made.due_on,
          link_url: made.link_url,
          completed_at: null,
          canceled_at: null,
          category: null,
          stories: [],
          points_done: 0,
          points_all: 0,
        },
        at: performance.now(),
      },
    ];
    showToast(t('epicCreated', { epic: t('epic') }), 'check');
    createdFlash.show({ kind: 'epic', id: made.id });
    return null;
  }

  // 空の行でストーリーを作る。epicId が null なら親のないストーリー。作れたら読み直さずに配下の末尾へ足す
  async function addStoryRow(epicId: string | null, title: string): Promise<string | null> {
    if (workspace === null) return t('storyCreateFailed');
    const sentFor = page.params.id;
    const result = await callOperation(
      storyCreate,
      { workspace_id: workspace.id, title, epic_id: epicId },
      { slug: page.params.slug ?? '' },
    );
    // 送っている間に別のワークスペースへ移っていたら、成功も失敗も、古い応答で状態を触らない
    if (sentFor !== page.params.id) return null;
    if (!result.ok) {
      if (result.status === 401) {
        await invalidateAll();
        return t('storyCreateFailed');
      }
      if (result.status === 409 && result.error?.code === 'workspace_closed') {
        void invalidateAll();
        return t('workspaceClosedReadOnly', { workspace: t('workspace') });
      }
      if (epicId !== null && result.status === 409 && result.error?.code === 'conflict') {
        // 親のエピックが完了か中止した。木を読み直すと空の行ごと消えるので、知らせはトーストに出し、フォーカスは見出しへ移す
        const message = t('treeAddParentDone', { epic: t('epic'), done: t('done'), story: t('story') });
        showToast(message, 'alert');
        await rowGone();
        return message;
      }
      if (epicId !== null && result.status === 404) {
        const message = t('epicGone', { epic: t('epic') });
        showToast(message, 'alert');
        await rowGone();
        return message;
      }
      return t('storyCreateFailed');
    }
    const made = result.data.story;
    if (filtering) {
      await saved('story', made.id);
      return null;
    }
    addedStories = [
      ...addedStories,
      {
        story: {
          id: made.id,
          title: made.title,
          due_on: made.due_on,
          link_url: made.link_url,
          category: made.category === null ? null : { id: made.category.id, name: made.category.name },
          completed_at: null,
          tasks: [],
          completed_task_count: 0,
          open_task_count: 0,
          points_done: 0,
          points_all: 0,
        },
        epicId,
        at: performance.now(),
      },
    ];
    if (epicId !== null) epicRows[epicId]?.expand();
    showToast(t('storyCreated', { story: t('story') }), 'check');
    createdFlash.show({ kind: 'story', id: made.id });
    return null;
  }

  // 空の行のタスクの題の検査（画面の検査は API の検証と同じ判定）
  function taskRowProblem(title: string): string | null {
    const problem = taskTitleProblem(title);
    if (problem === null) return null;
    if (problem === 'too_long') return t('taskTitleTooLong', { max: TASK_TITLE_MAX_LENGTH });
    if (problem === 'invalid_character') return t('taskTitleInvalidCharacter');
    return t('taskTitleRequired');
  }

  // 空の行でタスクを作る。storyId が null なら親のないタスク。題だけで送り、属性は作った後に決める。
  // 作れたら読み直さずに親の配下の末尾へ足す（created）。絞っているときは木を読み直し、作った行が当たらなければ知らせる
  async function addTaskRow(storyId: string | null, title: string): Promise<string | null> {
    if (workspace === null) return t('taskCreateFailed');
    const sentFor = page.params.id;
    const result = await callOperation(
      taskCreate,
      {
        workspace_id: workspace.id,
        title,
        points: null,
        assignee_user_id: null,
        story_id: storyId,
        repository_id: null,
        category_id: null,
      },
      { slug: page.params.slug ?? '' },
    );
    // 送っている間に別のワークスペースへ移っていたら、成功も失敗も、古い応答で状態を触らない
    if (sentFor !== page.params.id) return null;
    if (!result.ok) {
      if (result.status === 401) {
        await invalidateAll();
        return t('taskCreateFailed');
      }
      if (result.status === 409 && result.error?.code === 'workspace_closed') {
        void invalidateAll();
        return t('workspaceClosedReadOnly', { workspace: t('workspace') });
      }
      if (storyId !== null && result.status === 409 && result.error?.code === 'conflict') {
        // 親のストーリーが完了した。木を読み直すと空の行ごと消えるので、知らせはトーストに出し、フォーカスは見出しへ移す
        const message = t('treeAddTaskParentDone', { story: t('story'), done: t('done'), task: t('task') });
        showToast(message, 'alert');
        await rowGone();
        return message;
      }
      if (storyId !== null && result.status === 404) {
        const message = t('storyGone', { story: t('story') });
        showToast(message, 'alert');
        await rowGone();
        return message;
      }
      if (result.status === 400) return t('taskTitleInvalidCharacter');
      return t('taskCreateFailed');
    }
    const wasFiltering = filtering;
    await created(result.data.task, storyId);
    if (!wasFiltering) {
      const parent = storyId === null ? undefined : openStories.find((story) => story.id === storyId);
      showToast(
        parent === undefined
          ? t('taskCreated', { backlog: t('backlog') })
          : t('taskCreatedUnder', { story: t('story'), title: parent.title }),
        'check',
      );
    }
    return null;
  }

  // 直す対象のストーリーかエピックが消えていた。木を読み直し、フォーカスを見出しへ移す（ダイアログが閉じて、戻る先が無いため）
  async function rowGone(): Promise<void> {
    await invalidateAll();
    await tick();
    document.querySelector<HTMLElement>('h1.page-title')?.focus();
  }

  let moveDialog = $state<ReturnType<typeof MoveParentDialog<BacklogTask>>>();
  let storyMoveDialog = $state<ReturnType<typeof MoveParentDialog<BacklogStory>>>();
  // 動かした結果の読み上げ。領域は常に置き、中の文字だけを替える。同じ文が続いても読まれるよう、一度空にしてから入れる
  let moveStatus = $state('');
  async function announce(message: string): Promise<void> {
    moveStatus = '';
    await tick();
    moveStatus = message;
  }

  // 並べ替えで行の要素が動くと、その中のフォーカスが外れることがある。動かす前のフォーカスを、描き直した後に戻す
  function holdFocus(): () => Promise<void> {
    const active = document.activeElement;
    return async () => {
      await tick();
      if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active) active.focus();
    };
  }

  // ids の中で id を1つ動かした並びと、送る直前の行。下へは次の行の直後、上へは2つ上の行の直後（先頭になるなら null）
  function shifted(ids: readonly string[], id: string, delta: -1 | 1) {
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return null;
    const next = ids.filter((other) => other !== id);
    next.splice(to, 0, id);
    return { ids: next, index: to, after: to === 0 ? null : next[to - 1]! };
  }

  // 画面で動かした並びを捨てる。まだ送っていない操作も、世代を進めて捨てる
  function discardMoves(): void {
    movedRootCategories = {};
    movedParents = {};
    taskOrders = {};
    movedStoryParents = {};
    storyOrders = {};
    epicOrder = null;
    moves.discard();
  }

  // 木を読み直す。読み直しが失敗しても、送れなかった並びを出し続けない
  async function reloadTree(): Promise<void> {
    try {
      await invalidateAll();
    } finally {
      discardMoves();
    }
  }

  // フォーカスのある行（data-row-id）と、その行の中で何番目の操作か。読み直した後に同じ操作へ戻す
  function focusedControl(): { rowId: string; index: number } | null {
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-row-id]') : null;
    if (row === null || !(active instanceof HTMLElement)) return null;
    const index = [...row.querySelectorAll<HTMLElement>('a, button')].indexOf(active);
    return index === -1 ? null : { rowId: row.dataset.rowId ?? '', index };
  }

  async function restoreFocus(saved: { rowId: string; index: number } | null, lost: boolean): Promise<void> {
    if (saved === null && !lost) return;
    await tick();
    const row =
      saved === null
        ? null
        : [...document.querySelectorAll<HTMLElement>('[data-row-id]')].find((el) => el.dataset.rowId === saved.rowId);
    const control = saved === null ? undefined : row?.querySelectorAll<HTMLElement>('a, button')[saved.index];
    (control ?? document.querySelector<HTMLElement>('h1.page-title'))?.focus();
  }

  // 動かす操作を、押した順に送る。失敗したら理由を知らせて読み直し、フォーカスを同じ操作（無ければ見出し）へ戻す
  // reloadOnSuccess は、通った後にも、列が空になってから木を読み直す（絞っているときの親の移動。移す先の親が木に無いことがあり、
  // どの行を出すかはサーバーが決める。読み直すのは MoveQueue で、onFailed は断られたときだけ呼ばれる）
  function send(
    call: () => Promise<ApiResult<unknown>>,
    kind: 'task' | 'story' | 'epic',
    reloadOnSuccess = false,
  ): void {
    const workspaceId = workspace?.id;
    void moves.send(
      call,
      async (result) => {
        // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
        if (workspaceId !== page.params.id || result.ok) return;
        // 401 は、枠の読み直しがログインの画面へ移す
        if (result.status !== 401) showToast(moveFailureMessage(result, kind), 'alert');
        const saved = focusedControl();
        const lost = document.activeElement === null || document.activeElement === document.body;
        await reloadTree();
        await restoreFocus(saved, lost);
      },
      reloadOnSuccess,
    );
  }

  function reorderTask(task: BacklogTask, delta: -1 | 1): void {
    if (workspace === null) return;
    const parentId = taskPlaces[task.id]?.parentId ?? null;
    const key = parentId ?? ROOT;
    const next = shifted(
      (taskLists[key] ?? []).map((row) => row.id),
      task.id,
      delta,
    );
    // 端で Alt と ↑ ↓ を押したときは、動かせないことを読み上げる
    if (next === null) {
      void announce(delta < 0 ? t('moveAtTop') : t('moveAtBottom'));
      return;
    }
    const restore = holdFocus();
    taskOrders = { ...taskOrders, [key]: next.ids };
    void restore();
    void announce(t('moveAnnounced', { title: task.title, index: next.index + 1 }));
    const input = { workspace_id: workspace.id, task_id: task.id, story_id: parentId, after_task_id: next.after };
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }), 'task');
  }

  function reorderStory(story: BacklogStory, delta: -1 | 1): void {
    if (workspace === null) return;
    const parentId = storyPlaces[story.id]?.parentId ?? null;
    const key = parentId ?? ROOT;
    const next = shifted(
      (storyLists[key] ?? []).map((row) => row.id),
      story.id,
      delta,
    );
    if (next === null) {
      void announce(delta < 0 ? t('moveAtTop') : t('moveAtBottom'));
      return;
    }
    const restore = holdFocus();
    storyOrders = { ...storyOrders, [key]: next.ids };
    void restore();
    void announce(t('moveAnnounced', { title: story.title, index: next.index + 1 }));
    const input = { workspace_id: workspace.id, story_id: story.id, epic_id: parentId, after_story_id: next.after };
    send(() => callOperation(storyMove, input, { slug: page.params.slug ?? '' }), 'story');
  }

  // エピックを並べ替える。並べる範囲は画面に出ているエピックの全部（完了と中止したものも含む）
  function reorderEpic(epic: BacklogEpic, delta: -1 | 1): void {
    if (workspace === null) return;
    const next = shifted(epicIds, epic.id, delta);
    if (next === null) {
      void announce(delta < 0 ? t('moveAtTop') : t('moveAtBottom'));
      return;
    }
    const restore = holdFocus();
    epicOrder = next.ids;
    void restore();
    void announce(t('moveAnnounced', { title: epic.title, index: next.index + 1 }));
    const input = { workspace_id: workspace.id, epic_id: epic.id, after_epic_id: next.after };
    send(() => callOperation(epicMove, input, { slug: page.params.slug ?? '' }), 'epic');
  }

  function openMoveDialog(task: BacklogTask, trigger: HTMLElement): void {
    moveDialog?.show(trigger, task, taskPlaces[task.id]?.parentId ?? null);
  }

  function openStoryMoveDialog(story: BacklogStory, trigger: HTMLElement): void {
    storyMoveDialog?.show(trigger, story, storyPlaces[story.id]?.parentId ?? null);
  }

  // 親を移す（ダイアログが閉じた後に呼ばれる）。移す先の末尾に置き（API には直前の行を送らない）、畳まれていれば開く。
  // 行は移す先の下に作り直されるので、新しい行の「親を移す」へフォーカスを移す
  function moveParent(task: BacklogTask, storyId: string | null): void {
    if (workspace === null) return;
    const key = storyId ?? ROOT;
    const ids = (taskLists[key] ?? []).map((row) => row.id).filter((id) => id !== task.id);
    rememberCategoryForMove(task, storyId);
    movedParents = { ...movedParents, [task.id]: storyId };
    taskOrders = { ...taskOrders, [key]: [...ids, task.id] };
    if (storyId !== null) expandStory(storyId);
    void tick().then(() => entries[task.id]?.focusMoveParent());
    void announce(taskParentAnnouncement(task, storyId));
    const input = { workspace_id: workspace.id, task_id: task.id, story_id: storyId };
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }), 'task', filtering);
  }

  // 親を移したときの読み上げ。index（0 始まり）を渡すと「N 番目」まで伝え、渡さなければ「末尾へ」と伝える
  function taskParentAnnouncement(task: BacklogTask, storyId: string | null, index?: number): string {
    // 移す先は候補（絞っているときは木に無いストーリーもある）から引く
    // 候補に無ければ（選んだ後に完了した）、木の行から引く
    const parent =
      storyId === null
        ? undefined
        : (openStories.find((story) => story.id === storyId) ?? allStories.find((story) => story.id === storyId));
    // 親のストーリーがエピックの下なら、エピックの題も添える（同じ題のストーリーが、別のエピックの下にありうるため）
    const parentEpic =
      parent === undefined ? undefined : 'group' in parent ? (parent.group ?? undefined) : parentEpicOf(parent.id);
    const at = index === undefined ? undefined : index + 1;
    if (parent === undefined) {
      return at === undefined
        ? t('moveAnnouncedRoot', { title: task.title })
        : t('moveAnnouncedAtRoot', { title: task.title, index: at });
    }
    if (parentEpic === undefined) {
      const words = { title: task.title, story: t('story'), parent: parent.title };
      return at === undefined ? t('moveAnnouncedUnder', words) : t('moveAnnouncedAtUnder', { ...words, index: at });
    }
    const words = {
      title: task.title,
      epic: t('epic'),
      epicTitle: parentEpic.title,
      story: t('story'),
      parent: parent.title,
    };
    return at === undefined
      ? t('moveAnnouncedUnderEpic', words)
      : t('moveAnnouncedAtUnderEpic', { ...words, index: at });
  }

  function storyParentAnnouncement(story: BacklogStory, epicId: string | null, index?: number): string {
    const parent = epicId === null ? undefined : choiceEpics.find((epic) => epic.id === epicId);
    const at = index === undefined ? undefined : index + 1;
    if (parent === undefined) {
      return at === undefined
        ? t('moveAnnouncedRoot', { title: story.title })
        : t('moveAnnouncedAtRoot', { title: story.title, index: at });
    }
    const words = { title: story.title, story: t('epic'), parent: parent.title };
    return at === undefined ? t('moveAnnouncedUnder', words) : t('moveAnnouncedAtUnder', { ...words, index: at });
  }

  // つまみのドラッグで落とした。ボタンの並べ替えと同じく、先に画面を動かしてから送る。
  // 親を移したときは、移した先の親を含む文（末尾なら「末尾へ」、途中なら「N 番目」）を、同じ親の中なら「N 番目」を読み上げる。
  // 行は動くが、フォーカスは動かさない（マウスの操作）。
  // 落とした行は光らせる。畳まれた親は開く。直前の行は、末尾に置くときだけ省く
  function dropTask(move: DropMove): void {
    if (workspace === null) return;
    const task = Object.values(taskLists)
      .flat()
      .find((row) => row.id === move.id);
    if (task === undefined) return;
    const key = move.parentId ?? ROOT;
    const next = (taskLists[key] ?? []).map((row) => row.id).filter((id) => id !== task.id);
    next.splice(move.index, 0, task.id);
    if (move.reparent) rememberCategoryForMove(task, move.parentId);
    movedParents = { ...movedParents, [task.id]: move.parentId };
    taskOrders = { ...taskOrders, [key]: next };
    if (move.parentId !== null) expandStory(move.parentId);
    dnd.flash({ kind: 'task', id: task.id });
    void announce(
      move.reparent
        ? taskParentAnnouncement(task, move.parentId, move.atEnd ? undefined : move.index)
        : t('moveAnnounced', { title: task.title, index: move.index + 1 }),
    );
    const input = {
      workspace_id: workspace.id,
      task_id: task.id,
      story_id: move.parentId,
      ...(move.afterId === undefined ? {} : { after_task_id: move.afterId }),
    };
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }), 'task');
  }

  function dropStory(move: DropMove): void {
    if (workspace === null) return;
    const story = allStories.find((row) => row.id === move.id);
    if (story === undefined) return;
    const key = move.parentId ?? ROOT;
    const next = (storyLists[key] ?? []).map((row) => row.id).filter((id) => id !== story.id);
    next.splice(move.index, 0, story.id);
    movedStoryParents = { ...movedStoryParents, [story.id]: move.parentId };
    storyOrders = { ...storyOrders, [key]: next };
    if (move.parentId !== null) epicRows[move.parentId]?.expand();
    dnd.flash({ kind: 'story', id: story.id });
    void announce(
      move.reparent
        ? storyParentAnnouncement(story, move.parentId, move.atEnd ? undefined : move.index)
        : t('moveAnnounced', { title: story.title, index: move.index + 1 }),
    );
    const input = {
      workspace_id: workspace.id,
      story_id: story.id,
      epic_id: move.parentId,
      ...(move.afterId === undefined ? {} : { after_story_id: move.afterId }),
    };
    send(() => callOperation(storyMove, input, { slug: page.params.slug ?? '' }), 'story');
  }

  // エピックを落とした。親は無いので、エピックの段の中の位置だけを変える
  function dropEpic(move: DropMove): void {
    if (workspace === null) return;
    const epic = epics.find((row) => row.id === move.id);
    if (epic === undefined) return;
    const next = epicIds.filter((id) => id !== epic.id);
    next.splice(move.index, 0, epic.id);
    epicOrder = next;
    dnd.flash({ kind: 'epic', id: epic.id });
    void announce(t('moveAnnounced', { title: epic.title, index: move.index + 1 }));
    const input = {
      workspace_id: workspace.id,
      epic_id: epic.id,
      ...(move.afterId === undefined ? {} : { after_epic_id: move.afterId }),
    };
    send(() => callOperation(epicMove, input, { slug: page.params.slug ?? '' }), 'epic');
  }

  // ストーリーの親（エピック）を移す。タスクの親を移すのと同じ形
  function moveStoryParent(story: BacklogStory, epicId: string | null): void {
    if (workspace === null) return;
    const key = epicId ?? ROOT;
    const ids = (storyLists[key] ?? []).map((row) => row.id).filter((id) => id !== story.id);
    movedStoryParents = { ...movedStoryParents, [story.id]: epicId };
    storyOrders = { ...storyOrders, [key]: [...ids, story.id] };
    if (epicId !== null) epicRows[epicId]?.expand();
    void tick().then(() => treeRows[story.id]?.focusMoveParent());
    void announce(storyParentAnnouncement(story, epicId));
    const input = { workspace_id: workspace.id, story_id: story.id, epic_id: epicId };
    send(() => callOperation(storyMove, input, { slug: page.params.slug ?? '' }), 'story', filtering);
  }
</script>

<svelte:head>
  {#if workspace}
    <title>
      {t('pageTitle', {
        page: t('backlogPageName', { backlog: t('backlog'), name: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#snippet dropSlot(row: DropRow, label: string)}
  <!-- 親なしの段が空のとき、行をつかんでいる間だけ出す落とし先。重ねると囲み（.is-over）、離すと親なしの末尾に入る -->
  <div class="tree-slot">
    <div class="dropzone" class:is-over={rowDnd?.markOf(row) === 'into'} {@attach rowDnd?.target(row)}>
      <Icon name="swap" />
      <span class="dropzone-text"><b>{label}</b></span>
    </div>
  </div>
{/snippet}

{#snippet taskRow(task: BacklogTask)}
  {@const place = taskPlaces[task.id]}
  <!-- 親なしのタスクは、移す先のストーリーがあるときだけ「親を移す」を出す（ストーリーの下のタスクは、親なしへ移せる） -->
  <TaskEntry
    addedFlash={wasAdded('task', task.id)}
    bind:this={entries[task.id]}
    task={savedRow(task)}
    {clock}
    done={completedIds.includes(task.id)}
    justDone={completedIds.includes(task.id)}
    pending={pendingIds.includes(task.id)}
    canComplete={canWrite}
    onComplete={complete}
    canMoveUp={place !== undefined && place.index > 0}
    canMoveDown={place !== undefined && place.index < place.count - 1}
    onMove={canWrite && !filtering ? reorderTask : undefined}
    onMoveParent={canWrite && (place?.parentId != null || openStories.length > 0) ? openMoveDialog : undefined}
    onDelete={canWrite ? removeTask : undefined}
    showCategory={place?.parentId == null}
    dnd={rowDnd}
    taskQuery={taskQueryBase}
    attrs={canWrite && workspace !== null
      ? {
          slug: page.params.slug ?? '',
          workspaceId: workspace.id,
          onSaved: () => invalidateAll(),
          loadedAt: data.loadedAt,
          onStale: () => void invalidateAll(),
          definitions: data.definitions,
        }
      : undefined}
  />
{/snippet}

{#snippet storyRow(story: BacklogStory)}
  {@const place = storyPlaces[story.id]}
  {@const epic = parentEpicOf(story.id)}
  <!-- 親のないストーリーは、移す先のエピックがあるときだけ「親を移す」を出す（エピックの下のストーリーは、親なしへ移せる）。
       完了か中止したエピックの下では、完了と取り消しは必ず断られるので、押せない理由を出す -->

  <TreeStory
    addedFlash={wasAdded('story', story.id)}
    bind:this={treeRows[story.id]}
    {story}
    completedContext={!filtering && workspace
      ? { slug: page.params.slug ?? '', workspaceId: workspace.id, revision: tree }
      : undefined}
    tasks={storyRows(story)}
    pointsDone={pointsDoneOf(story)}
    pointsAll={pointsAllOf(story)}
    {clock}
    nested={place?.parentId != null}
    remaining={remainingOf(story)}
    pending={Object.hasOwn(storyPending, story.id)}
    parentFinished={epic !== undefined && (epic.completed_at !== null || epic.canceled_at !== null)}
    onComplete={canWrite ? (target) => void setStoryCompletion(target, 'complete') : undefined}
    onReopen={canWrite ? (target) => void setStoryCompletion(target, 'reopen') : undefined}
    href={`${storyHrefBase}${encodeURIComponent(story.id)}`}
    row={taskRow}
    canMoveUp={place !== undefined && place.index > 0}
    canMoveDown={place !== undefined && place.index < place.count - 1}
    onMove={canWrite && !filtering ? reorderStory : undefined}
    onMoveParent={canWrite && (place?.parentId != null || openEpics.length > 0) ? openStoryMoveDialog : undefined}
    dnd={rowDnd}
  >
    {#snippet addRow()}
      {#if canWrite && story.completed_at === null}
        <DraftRow
          label={t('treeAddTask', { task: t('task') })}
          name={t('treeAddTaskUnder', { title: story.title, task: t('task') })}
          problem={taskRowProblem}
          create={(title) => addTaskRow(story.id, title)}
        />
      {/if}
    {/snippet}
  </TreeStory>
{/snippet}

{#if workspace && tree === null}
  <!-- 絞っている間に読めなかったときは、絞り込みを外す操作も添える（絞り込みが原因でも抜け出せるように） -->
  {#snippet clearOnFailure()}
    <button class="btn is-sm is-quiet" type="button" onclick={() => void applyFilter(emptyFilter)}
      ><Icon name="x" />{t('filterClear')}</button
    >
  {/snippet}
  <LoadFailed
    inShell
    extra={filtering ? clearOnFailure : undefined}
    note={reloadFailureNote(workspace.id) ?? undefined}
  />
{:else if workspace && tree}
  <!-- チーム全体の経験値は、読めたときだけ見出しの中に出す（読めなくても画面は開く） -->
  {#snippet teamExperience()}
    {#if data.teamTotal !== null}<TeamExperience total={data.teamTotal} />{/if}
  {/snippet}
  <PageHead
    title={t('backlog')}
    narrowSummary={t('backlogSummary')}
    eyebrow={workspace.name}
    focusable
    tallies={[
      { icon: 'board', label: t('backlogTallyOpen', { task: t('task') }), count: tallies.open_count },
      { tone: 'warn', icon: 'pen', label: t('unfilledChip', { detail: t('detail') }), count: tallies.unfilled_count },
      { tone: 'warn', label: t('pointsUnsetTitle'), count: tallies.unestimated_count },
      { label: t('backlogTallyUnscheduled', { sprint: t('sprint') }), count: tallies.unscheduled_count },
    ]}
    meta={data.teamTotal === null ? undefined : teamExperience}
  ></PageHead>

  <!-- 完成の定義（components.css の .dod）。木の上に1つだけ畳んで置き、行ごとには繰り返さない。空なら出さない。
       本文は開くまで描かない（長い定義の変換と描画を、開かない人に払わせない） -->
  {#if workspace.definitionOfDone !== null}
    <details class="dod" bind:open={dodOpen}>
      <summary>{t('dod')}</summary>
      {#if dodOpen}<Markdown source={workspace.definitionOfDone} headingStart={2} />{/if}
    </details>
  {/if}

  <!-- 完了の操作を送っている最中の読み上げと、動かした結果の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{completingStatus}</span>
  <span class="visually-hidden" role="status">{moveStatus}</span>
  <!-- 絞り込みの結果の読み上げ。木を読み直すたびに中の文字を替える（同じ文なら読み上げない） -->
  <span class="visually-hidden" role="status">{filterResult}</span>

  <!-- 何も無いときの最初の一歩は、見本どおり絞り込みの帯も出さない。絞っているときは、当たるものが無くても帯を出す -->
  <!-- 最初の1件を作ると空の状態だけが外れ、木と空の行は同じ位置に残す（空の行を作り直すとフォーカスを失うため） -->
  {@const firstStep =
    !filtering && epics.length === 0 && tree.stories.length === 0 && rootRows.length === 0 && rootDone === 0}
  {#if firstStep}
    <EmptyState
      icon="board"
      art="notice"
      title={t('backlogEmptyTitle', { task: t('task') })}
      text={canWrite
        ? t('backlogEmptyText', { task: t('task') })
        : t('backlogEmptyClosedText', { task: t('task'), workspace: t('workspace') })}
    />
  {/if}
  <!-- 起票のダイアログが無いので、書ける人には最初の一歩の空の行を出す -->
  {#if !firstStep || canWrite}
    <section class="section" aria-label={t('backlogTasksLabel', { backlog: t('backlog'), task: t('task') })}>
      {#if !firstStep}
        <BacklogFilterBar
          {filter}
          choices={tree.choices}
          categories={data.definitions?.categories ?? []}
          repositories={data.definitions?.repositories ?? []}
          definitionsFailed={data.definitions === null}
          onchange={(next) => void applyFilter(next)}
        />
      {/if}
      {#if filtering}
        <!-- 当たる行が0件でも、見出しの集計は絞る前の全体の値 -->
        <p class="action-note">{t('filterTotalsNote', { points: t('points') })}</p>
      {/if}
      {#if !firstStep && filtering && epics.length === 0 && tree.stories.length === 0 && rootRows.length === 0}
        <!-- 絞り込みに当たるものが無い。木の代わりに、無いことと、絞り込みを外す操作を出す -->
        <EmptyState icon="search" title={t('backlogNoMatchTitle')} text={t('backlogNoMatchText')}>
          {#snippet actions()}
            <button class="btn is-sm" type="button" onclick={() => void clearFilter()}
              ><Icon name="x" />{t('filterClear')}</button
            >
          {/snippet}
        </EmptyState>
      {:else}
        {#if canWrite && !firstStep}
          <!-- 絞っている間は並べ替えを出さないので、外すと並べ替えられることを案内する -->
          {#if filtering}
            <p class="action-note">{t('backlogFilterOrderNote')}</p>
          {:else}
            <div class="order-help">
              <span class="order-priority">{t('backlogPriority')}</span>
              <NarrowDisclosure label={t('backlogOrderHelp')}>
                <p class="action-note">
                  {t('backlogOrderNote', { epic: t('epic'), story: t('story'), task: t('task') })}
                  <span class="drag-note">{t('backlogDragNote')}</span>
                </p>
              </NarrowDisclosure>
            </div>
          {/if}
        {/if}
        {@render treeView()}
      {/if}
    </section>
  {/if}

  {#snippet treeView()}
    <!-- 引き出しの前後のボタンの順は、木に今見えているタスクの行（畳んだ枝の中と、絞り込みで外れた行を除く） -->
    <div class="tree" aria-busy={reloading} {@attach trackTaskOrder} {@attach trackStoryOrder}>
      {#each epics as epic, epicIndex (epic.id)}
        {@const points = epicPoints(epic)}
        <TreeEpic
          addedFlash={wasAdded('epic', epic.id)}
          bind:this={epicRows[epic.id]}
          {epic}
          pointsDone={points.done}
          pointsAll={points.all}
          {clock}
          empty={epicStories(epic).length === 0}
          canMoveUp={epicIndex > 0}
          canMoveDown={epicIndex < epics.length - 1}
          onMove={canWrite && !filtering ? reorderEpic : undefined}
          dnd={rowDnd}
          href={`${epicHrefBase}${encodeURIComponent(epic.id)}`}
        >
          {#each epicStories(epic) as story (story.id)}
            {@render storyRow(story)}
          {/each}
          {#snippet addRow()}
            {#if canWrite}
              <DraftRow
                label={t('treeAddStory', { story: t('story') })}
                name={t('treeAddStoryUnder', { title: epic.title, story: t('story') })}
                problem={(title) => rowTitleProblem('story', title)}
                create={(title) => addStoryRow(epic.id, title)}
              />
            {/if}
          {/snippet}
        </TreeEpic>
      {/each}
      {#each rootStoryList as story (story.id)}
        {@render storyRow(story)}
      {/each}
      {#if rootStoryList.length === 0 && rowDnd?.item?.kind === 'story'}
        {@render dropSlot(storySlot, t('dropSlotStory', { story: t('story') }))}
      {/if}
      <!-- 絞っているときは、親のない完了の件数が返らない（null）ので、折りたたみの1行を出さない -->
      {#if rootRows.length > 0 || rootDone > 0}
        <div>
          {#if rootRows.length === 0 && epics.length === 0 && tree.stories.length === 0}
            <EmptyState
              icon="board"
              title={t('backlogNoOpenTitle', { task: t('task') })}
              text={canWrite
                ? t('backlogNoOpenText', { task: t('task') })
                : t('backlogEmptyClosedText', { task: t('task'), workspace: t('workspace') })}
            />
          {/if}
          {#each rootRows as task (task.id)}
            {@render taskRow(task)}
          {/each}
          {#if rootDone > 0}
            {#key workspace.id}
              <CompletedTasks
                slug={page.params.slug ?? ''}
                workspaceId={workspace.id}
                count={rootDone}
                revision={tree}
                root
                dnd={rowDnd}
                tailRow={rootTail}
              />
            {/key}
          {/if}
        </div>
      {:else if rowDnd?.item?.kind === 'task'}
        {@render dropSlot(taskSlot, t('dropSlotTask', { task: t('task') }))}
      {/if}
      <!-- 木の末尾の空の行。エピックは最上段に、親のないストーリーは親なしで作る（エピックの下は、各エピックの末尾の行） -->
      {#if canWrite}
        <DraftRow
          label={t('treeAddEpic', { epic: t('epic') })}
          problem={(title) => rowTitleProblem('epic', title)}
          create={addEpicRow}
        />
        <DraftRow
          label={t('treeAddStory', { story: t('story') })}
          problem={(title) => rowTitleProblem('story', title)}
          create={(title) => addStoryRow(null, title)}
        />
        <DraftRow
          bind:this={rootTaskRow}
          keyshortcut={ariaKeyshortcuts(NEW_TASK_KEY)}
          label={t('treeAddTask', { task: t('task') })}
          problem={taskRowProblem}
          create={(title) => addTaskRow(null, title)}
        />
      {/if}
    </div>
  {/snippet}

  {#if canWrite}
    <MoveParentDialog bind:this={moveDialog} parents={openStories} onmove={moveParent} />
    <MoveParentDialog bind:this={storyMoveDialog} parents={openEpics} onmove={moveStoryParent} />
  {/if}
{/if}
