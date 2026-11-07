<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BacklogStory, BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import type { DropRow } from '../backlog-drop.ts';
  import type { BacklogDnd } from '../backlog-dnd.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import CompletedTasks from './CompletedTasks.svelte';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import RowMenu, { type RowMenuItem } from './RowMenu.svelte';

  // kit.js の treeStory（バックログの木のストーリーの行と、配下）。親のないストーリーの行と、エピックの下のストーリーの行（nested）。
  // 行は普通の要素で、開閉は左端の caret のボタン（aria-expanded と aria-controls）だけが受け持つ。
  // 題を押すとストーリーのダイアログ（onEdit）を開く。
  // 開閉のボタンと題は独立したボタンなので、押しても行は開閉しない。開閉の状態は部品の中に持ち、expand() で開ける（起票した親を開く）。
  // タスクは配下の末尾の空の行（addRow）で足す（行に「＋タスク」のボタンは置かない）。
  // 完了したストーリーの期日には色を付けない。
  // tasks は未完了の行（画面が足した行を含む）。pointsDone と pointsAll は、画面が足した行と完了にした行の分を含む合計。
  // 配下のタスクの行は row の snippet で描く（完了の操作は画面の側が持つ）。
  // 行の操作は、完了のしるし（完了したストーリーの .hanko と「取り消す」）のほかは、右端の「⋯」（RowMenu）のメニューにまとめる。
  // onComplete を渡すと（書き込めるとき）、完了していないストーリーのメニューに「完了にする」を出す。配下の未完了のタスク（remaining。
  // 画面で完了にした行は数えない）が残るあいだは、押しても何も起きない aria-disabled にして、横に「残り N 件の<タスク>」を出す。
  // 完了したストーリーには完了の印（.hanko）を付け、onReopen を渡すと「取り消す」を出す。親のエピックが完了か中止していれば
  // （parentFinished）、完了と取り消しは必ず断られるので aria-disabled にし、理由を横に出す。送っている間（pending）は、どちらも aria-disabled。
  // onMove を渡すと（書き込めるとき）、メニューに「上へ」「下へ」を出し、ストーリーの行の中で Alt と ↑ ↓ を押しても同じことをする。
  // キーは配下のタスクの行には掛けない（タスクの行は自分で受け持つ）。端の向きは aria-disabled にする。
  // onMoveParent を渡すと、メニューに「親を移す」（親のエピックを選ぶダイアログ）も出す。絞り込み中は、画面が onMove を渡さず
  // （並べ替えは隣を使うため。Alt と ↑ ↓ も効かない）、「親を移す」だけを出す
  // onMove と dnd を渡すと（書き込めて、絞っていないとき）、行の先頭にドラッグのつまみ（.grip。飾りで aria-hidden）を置く。つかむのはここだけ。
  // 行は、タスクを運ぶときの落とし先（囲み。離すと配下の末尾に入り、畳まれていれば開く）と、ストーリーを運ぶときの前後の線の落とし先を兼ねる。
  // 前後の線は、開いた配下の途中に入らないよう、配下を含めた塊（.tree-group）に引く。
  // 折りたたみの行と空の案内の行の前後は、配下の末尾の落とし先
  // addRow を渡すと（書き込める、完了していないとき）、配下の末尾（折りたたみの行や空の案内の行の後）に「タスクを足す」の空の行（DraftRow）を置く
  let {
    story,
    completedContext,
    tasks,
    pointsDone,
    pointsAll,
    clock,
    onEdit,
    row,
    nested = false,
    remaining = 0,
    pending = false,
    parentFinished = false,
    onComplete,
    onReopen,
    canMoveUp = false,
    canMoveDown = false,
    onMove,
    onMoveParent,
    dnd,
    addRow,
  }: {
    story: BacklogStory;
    completedContext?: { slug: string; workspaceId: string; revision: unknown };
    tasks: readonly BacklogTask[];
    pointsDone: number;
    pointsAll: number;
    clock: { today: string; weekStart: number };
    onEdit: (story: BacklogStory, trigger: HTMLElement) => void;
    row: Snippet<[BacklogTask]>;
    nested?: boolean;
    remaining?: number;
    pending?: boolean;
    parentFinished?: boolean;
    onComplete?: (story: BacklogStory) => void;
    onReopen?: (story: BacklogStory) => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMove?: (story: BacklogStory, delta: -1 | 1) => void;
    onMoveParent?: (story: BacklogStory, trigger: HTMLElement) => void;
    dnd?: BacklogDnd;
    // 配下の末尾に置く空の行（タスクを足す）。完了したストーリーと、閉じたワークスペースには渡さない
    addRow?: Snippet;
  } = $props();

  const dropRow = $derived<DropRow>({ kind: 'story', id: story.id });
  const tailRow = $derived<DropRow>({ kind: 'tail', parent: 'story', id: story.id });
  const hasGrip = $derived(onMove !== undefined && dnd !== undefined);
  const dropMark = $derived(dnd?.markOf(dropRow));

  function move(delta: -1 | 1): void {
    if (delta < 0 ? !canMoveUp : !canMoveDown) return;
    onMove?.(story, delta);
  }

  function keydown(event: KeyboardEvent): void {
    if (onMove === undefined || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // 端でも画面に渡す（画面が、動かせないことを読み上げる）
    onMove(story, event.key === 'ArrowUp' ? -1 : 1);
  }

  const bodyId = $props.id();
  const remainingId = `${bodyId}-remaining`;
  const blockedId = `${bodyId}-blocked`;
  let expanded = $state(true);
  const finished = $derived(story.completed_at !== null);

  export function expand(): void {
    expanded = true;
  }

  // 完了と取り消しの後は木を読み直すので、画面が新しい行の操作へフォーカスを移すのに使う
  let reopenButton = $state<HTMLButtonElement>();
  let mark = $state<HTMLElement>();
  let menu = $state<ReturnType<typeof RowMenu>>();
  export function focusCompletion(): void {
    // bind:this は、要素が消えると null に戻る（戻る前に呼ばれても、つながっている要素だけを選ぶ）
    const target = [reopenButton, mark].find((el) => el?.isConnected === true);
    if (target) target.focus();
    else menu?.focus();
  }
  // 親を移すと行は別の親の下に作り直されるので、画面が新しい行の「⋯」へフォーカスを戻すのに使う
  export function focusMoveParent(): void {
    menu?.focus();
  }

  // 完了の丸のほかの操作は「⋯」にまとめる。配下の未完了のタスクが残るあいだと、完了か中止したエピックの下では、
  // 「完了にする」は押しても何も起きない aria-disabled にして、横の説明（.tree-note）で理由を示す
  const menuItems = $derived<RowMenuItem[]>([
    ...(onMove !== undefined
      ? [
          { key: 'up', label: t('moveUp'), icon: 'up' as const, disabled: !canMoveUp, onselect: () => move(-1) },
          { key: 'down', label: t('moveDown'), icon: 'down' as const, disabled: !canMoveDown, onselect: () => move(1) },
        ]
      : []),
    ...(onMoveParent !== undefined
      ? [
          {
            key: 'swap',
            label: t('moveParent'),
            icon: 'swap' as const,
            onselect: (trigger: HTMLButtonElement) => onMoveParent?.(story, trigger),
          },
        ]
      : []),
    ...(!finished && onComplete !== undefined
      ? [
          {
            key: 'complete',
            label: t('complete'),
            icon: 'check' as const,
            disabled: pending || parentFinished || remaining > 0,
            describedby: parentFinished ? blockedId : remaining > 0 ? remainingId : undefined,
            onselect: () => {
              if (!pending && !parentFinished && remaining === 0) onComplete(story);
            },
          },
        ]
      : []),
  ]);
</script>

<div
  class="tree-group"
  class:is-dragging={dnd?.isDragging('story', story.id)}
  data-drop={dropMark === 'into' ? undefined : dropMark}
>
  <!-- キーは中のボタンから届く。行そのものはフォーカスを受けない -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="tree-row is-story"
    class:is-root={!nested}
    class:has-grip={hasGrip}
    class:is-dropped={dnd?.isFlashing('story', story.id)}
    onkeydown={keydown}
    data-row-id={story.id}
    data-drop={dropMark === 'into' ? 'into' : undefined}
    {@attach dnd?.target(dropRow)}
  >
    {#if hasGrip}
      <span class="grip" aria-hidden="true" {@attach dnd?.handle({ kind: 'story', id: story.id })}
        ><Icon name="grip" /></span
      >
    {/if}
    <button
      class="tree-caret"
      type="button"
      aria-expanded={expanded}
      aria-controls={bodyId}
      aria-label={expanded ? t('treeClose', { title: story.title }) : t('treeOpen', { title: story.title })}
      onclick={() => (expanded = !expanded)}
    >
      <Icon name="chevron" />
    </button>
    <span class="kind is-story" title={t('story')}><Icon name="check" /></span>
    <span class="tree-title">
      <button class="tree-link" type="button" onclick={(event) => onEdit(story, event.currentTarget)}
        >{story.title}</button
      >
      <!-- 区分は親のないストーリーにだけ出す（エピックの下では、エピックの行に出ている区分を引き継ぐ） -->
      {#if !nested && story.category !== null}
        <DefinitionChip kind="category" name={story.category.name} />
      {/if}
      {#if story.due_on !== null}
        <DueChip dueOn={story.due_on} today={clock.today} weekStart={clock.weekStart} done={finished} />
      {/if}
    </span>
    <span class="tree-end">
      <span class="tree-ratio" title={t('treeRatioTitle', { done: t('done') })}
        >{t('treeRatio', { done: t('done'), value: pointsDone, all: pointsAll })}</span
      >
      {#if finished}
        <!-- tabindex="-1" は、取り消せないとき（閉じたワークスペース）に、完了にした後のフォーカスを置くため -->
        <span
          class="hanko"
          role="img"
          aria-label={t('doneMarkLabel', { title: story.title, done: t('done') })}
          tabindex="-1"
          bind:this={mark}
        >
          <Icon name="check" /><b>{t('doneStamp')}</b>
        </span>
        {#if onReopen !== undefined}
          {#if parentFinished}
            <span class="tree-note" id={blockedId}
              >{t('storyReopenBlocked', { done: t('done'), epic: t('epic'), story: t('story') })}</span
            >
          {/if}
          <button
            class="btn is-sm is-quiet"
            type="button"
            aria-label={t('storyReopenLabel', { done: t('done'), title: story.title })}
            aria-describedby={parentFinished ? blockedId : undefined}
            aria-disabled={pending || parentFinished}
            bind:this={reopenButton}
            onclick={() => {
              if (!pending && !parentFinished) onReopen(story);
            }}>{t('storyReopen')}</button
          >
        {/if}
      {:else if onComplete !== undefined}
        {#if parentFinished}
          <span class="tree-note" id={blockedId}
            >{t('storyCompleteBlocked', { done: t('done'), epic: t('epic'), story: t('story') })}</span
          >
        {:else if remaining > 0}
          <span class="tree-note" id={remainingId}>{t('storyRemaining', { count: remaining, task: t('task') })}</span>
        {/if}
      {/if}
      {#if menuItems.length > 0}
        <RowMenu title={story.title} items={menuItems} bind:this={menu} />
      {/if}
    </span>
  </div>
  <div class="tree-children" id={bodyId} hidden={!expanded}>
    {#each tasks as task (task.id)}
      {@render row(task)}
    {/each}
    {#if story.completed_task_count > 0}
      {#if completedContext !== undefined}
        <CompletedTasks
          {...completedContext}
          storyId={story.id}
          storyTitle={story.title}
          count={story.completed_task_count}
          {dnd}
          {tailRow}
        />
      {:else}
        <!-- 絞り込み中は開く操作を出さず、件数の1行だけにする -->
        <p class="tree-folded" data-drop={dnd?.markOf(tailRow)} {@attach dnd?.target(tailRow)}>
          {t('storyFolded', { done: t('done'), count: story.completed_task_count })}
        </p>
      {/if}
    {:else if tasks.length === 0}
      <p class="tree-folded" data-drop={dnd?.markOf(tailRow)} {@attach dnd?.target(tailRow)}>
        {t('storyNoTasks', { task: t('task') })}
      </p>
    {/if}
    {@render addRow?.()}
  </div>
</div>
