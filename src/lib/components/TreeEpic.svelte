<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BacklogEpic } from '../../shared/operations/task/backlog-tree.ts';
  import type { DropRow } from '../backlog-drop.ts';
  import type { BacklogDnd } from '../backlog-dnd.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import RowMenu, { type RowMenuItem } from './RowMenu.svelte';

  // kit.js の treeEpic（バックログの木のエピックの行と、配下）。行の組み方は TreeStory と同じで、開閉は左端の caret のボタンだけが受け持ち、
  // 題はリンクで、押すとエピックの引き出し（`?epic=<ID>`。EpicDrawer）を開く（引き出しの下から、エピックの画面へ移れる）。開閉の状態は部品の中に持ち、expand() で開ける（ストーリーを移してきたときに開く）。
  // 右端は配下のポイントの「完了 / 全体」（pointsDone と pointsAll は、画面が足した行と完了にした行の分を含む合計）。
  // 完了（クリア）か中止したエピックには、その状態の印を添え、期日には色を付けない。
  // 配下のストーリーの行は children の snippet で描く（ストーリーの操作は画面の側が持つ）。empty が真なら「<ストーリー>はまだありません」を出す。
  // クリア、中止は、エピックの画面の続きの Issue（#65）で足す。
  // onMove を渡すと（書き込めて、絞っていないとき）、行の右端の「⋯」のメニューに「上へ」「下へ」を出し、エピックの行の中で Alt と ↑ ↓ を押しても同じことをする
  // （TreeStory と同じ。キーは配下のストーリーとタスクの行には掛けない。端の向きは aria-disabled）。完了と中止したエピックも並べ替えられる。
  // onMove と dnd を渡すと、行の先頭にドラッグのつまみ（.grip。飾りで aria-hidden）を置く。つかむのはここだけ。
  // dnd を渡すと、行は、ストーリーを運ぶときの落とし先（囲み。離すと配下の末尾に入り、畳まれていれば開く）と、エピックを運ぶときの
  // 前後の線の落とし先を兼ねる。前後の線は、開いた配下の途中に入らないよう、配下を含めた塊（.tree-group）に引く（エピックの段の字下げ）。
  // 空の案内の行の前後も、配下の末尾の落とし先
  // addRow を渡すと（書き込める、完了も中止もしていないとき）、配下の末尾に「ストーリーを足す」の空の行（DraftRow）を置く
  let {
    epic,
    pointsDone,
    pointsAll,
    clock,
    empty,
    canMoveUp = false,
    canMoveDown = false,
    onMove,
    dnd,
    href,
    children,
    addRow,
  }: {
    epic: BacklogEpic;
    pointsDone: number;
    pointsAll: number;
    clock: { today: string; weekStart: number };
    empty: boolean;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMove?: (epic: BacklogEpic, delta: -1 | 1) => void;
    dnd?: BacklogDnd;
    // 題のリンクの行き先（画面が、今の絞り込みを残して `?epic=<ID>` を付けた経路）
    href: string;
    children: Snippet;
    // 配下の末尾に置く空の行（ストーリーを足す）。完了か中止したエピックには置かない
    addRow?: Snippet;
  } = $props();

  const dropRow = $derived<DropRow>({ kind: 'epic', id: epic.id });
  const tailRow = $derived<DropRow>({ kind: 'tail', parent: 'epic', id: epic.id });
  const hasGrip = $derived(onMove !== undefined && dnd !== undefined);
  const dropMark = $derived(dnd?.markOf(dropRow));

  function move(delta: -1 | 1): void {
    if (delta < 0 ? !canMoveUp : !canMoveDown) return;
    onMove?.(epic, delta);
  }

  const menuItems = $derived<RowMenuItem[]>([
    { key: 'up', label: t('moveUp'), icon: 'up' as const, disabled: !canMoveUp, onselect: () => move(-1) },
    { key: 'down', label: t('moveDown'), icon: 'down' as const, disabled: !canMoveDown, onselect: () => move(1) },
  ]);

  function keydown(event: KeyboardEvent): void {
    if (onMove === undefined || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // 端でも画面に渡す（画面が、動かせないことを読み上げる）
    onMove(epic, event.key === 'ArrowUp' ? -1 : 1);
  }

  const bodyId = $props.id();
  let expanded = $state(true);
  const finished = $derived(epic.completed_at !== null || epic.canceled_at !== null);

  export function expand(): void {
    expanded = true;
  }
</script>

<div
  class="tree-group"
  class:is-dragging={dnd?.isDragging('epic', epic.id)}
  data-drop={dropMark === 'into' ? undefined : dropMark}
>
  <!-- キーは中のボタンから届く。行そのものはフォーカスを受けない -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="tree-row is-epic"
    class:has-grip={hasGrip}
    class:is-dropped={dnd?.isFlashing('epic', epic.id)}
    onkeydown={keydown}
    data-row-id={epic.id}
    data-drop={dropMark === 'into' ? 'into' : undefined}
    {@attach dnd?.target(dropRow)}
  >
    {#if hasGrip}
      <span class="grip" aria-hidden="true" {@attach dnd?.handle({ kind: 'epic', id: epic.id })}
        ><Icon name="grip" /></span
      >
    {/if}
    <button
      class="tree-caret"
      type="button"
      aria-expanded={expanded}
      aria-controls={bodyId}
      aria-label={expanded ? t('treeClose', { title: epic.title }) : t('treeOpen', { title: epic.title })}
      onclick={() => (expanded = !expanded)}
    >
      <Icon name="chevron" />
    </button>
    <span class="kind is-epic" title={t('epic')}><Icon name="flag" /></span>
    <span class="tree-title">
      <!-- 押しても、一覧のスクロールとフォーカスの位置は動かさない（引き出しが閉じたとき、data-epic-id で探してフォーカスを戻す） -->
      <!-- eslint-disable svelte/no-navigation-without-resolve -- href は画面が resolve した経路に ?epic=<ID> を足したもの -->
      <a class="tree-link" {href} data-epic-id={epic.id} data-sveltekit-reset="false">{epic.title}</a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
      <!-- 区分はエピックに振ったものを出す（配下のストーリーとタスクは引き継ぐので、繰り返さない） -->
      {#if epic.category !== null}
        <DefinitionChip kind="category" name={epic.category.name} />
      {/if}
      {#if epic.completed_at !== null}
        <span class="chip is-done"><Icon name="check" />{t('epicCleared')}</span>
      {:else if epic.canceled_at !== null}
        <span class="chip">{t('epicCanceled')}</span>
      {/if}
      {#if epic.due_on !== null}
        <DueChip dueOn={epic.due_on} today={clock.today} weekStart={clock.weekStart} done={finished} />
      {/if}
    </span>
    <span class="tree-end">
      <span class="tree-ratio" title={t('treeRatioTitle', { done: t('done') })}
        >{t('treeRatio', { done: t('done'), value: pointsDone, all: pointsAll })}</span
      >
      {#if onMove !== undefined}
        <RowMenu title={epic.title} items={menuItems} />
      {/if}
    </span>
  </div>
  <div class="tree-children" id={bodyId} hidden={!expanded}>
    {@render children()}
    {#if empty}
      <p class="tree-folded" data-drop={dnd?.markOf(tailRow)} {@attach dnd?.target(tailRow)}>
        {t('epicNoStories', { story: t('story') })}
      </p>
    {/if}
    {#if addRow !== undefined && !finished}
      {@render addRow()}
    {/if}
  </div>
</div>
