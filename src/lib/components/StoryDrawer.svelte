<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import {
    storyComplete,
    storyGet,
    storyMove,
    storyReopen,
    storyUpdate,
    type StoryDetail,
  } from '../../shared/operations/story/index.ts';
  import { categoryRepositoryList, type DefinitionRef } from '../../shared/operations/definition/index.ts';
  import { categoryConflictReasonOf } from '../../shared/operations/definition/definition.ts';
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
  } from '../../shared/story.ts';
  import { callOperation } from '../api.ts';
  import { withCurrent } from '../definition-options.ts';
  import {
    clearStepFocus,
    consumeStepFocus,
    markStepFocus,
    pickTaskOpenMode,
    type StepSource,
    type TaskOpenMode,
  } from '../drawer.svelte.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { moveFailureMessage } from '../move-failure.ts';
  import { completionFailureMessage } from '../story-completion.ts';
  import { staleCurrentOf, type StoryFacts } from '../story-drawer.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import AutoSaveEdit from './AutoSaveEdit.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Drawer from './Drawer.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import Markdown from './Markdown.svelte';
  import MoveParentDialog from './MoveParentDialog.svelte';
  import RowMenu from './RowMenu.svelte';
  import TreeDeleteDialog from './TreeDeleteDialog.svelte';

  // ストーリーの引き出しの中身（TaskDrawer のストーリー版）。`?story=<ID>` が付いている間、ワークスペースの枠（/[slug]/w/[id] のレイアウト）が置く。
  // 開いたら story-get で1件を読む（受け入れ基準と本文は長いので、木には載せない）。読んでいる間は読み込み中を出し、読めなければ
  // （404 以外）もう一度試すを出す（フォーカスもそこへ置く）。404 は、トーストで知らせて閉じ、画面が木を読み直す（onremoved）。
  // 欄ごとに、その場で直す。タイトル、受け入れ基準、本文、リンクは AutoSaveEdit（押したら書け、欄を離れるか手を止めると保存する。
  // 受け入れ基準と本文は Markdown の描画）。期日と区分は選んだら（期日は年が4桁そろった値だけを、少し待ってから、か欄を離れる／Enter で、
  // 区分は少し待ってから、か欄を離れたときに）保存する。送る欄は今の値と違うものだけで、保存したら、その欄だけを応答で入れ替え、
  // 画面が木を読み直す（onchanged。枠の読み直しが一時的に失敗しても、引き出しと書きかけを失わないため、木だけ）。
  // 自動保存の欄と期日は、書き始めた時点の値（bases）を expected に添えて送る。先にほかの人が同じ欄を直していたら（409 の stale）、保存せずに
  // 今の値を並べて知らせ、書いた分は欄に残す（TaskDrawer と同じ。次の保存は、今の値を読んだものとして送る。期日は、断られた値のままでは
  // 欄を離れても送り直さず、Enter か値を替えたときに送る）。区分は expected が無く、後の保存が勝つ。
  // 保存、完了、削除の宛先は、開いたときのストーリーの ID（openedId）。props の storyId は、閉じた後や前後へ移った後に替わる
  // ストーリーの受け入れ基準と本文には添付のファイルが無いので、Markdown の欄でなく、文字の欄にする
  // 区分は親のないストーリーだけが持つ。エピックの下のストーリーは、エピックの区分を「親から引き継ぎ」で読み取り専用に出す。
  // 閉じたワークスペース（canWrite が偽）では、直す口と操作を出さず、読み取り専用で開く。
  // 書きかけ（タイトル、受け入れ基準、本文、リンクの直している途中で、保存と同じ整え方の後も値が保存した値と違うもの。保存の要求を送っている間も数える。
  // と、まだ送っていない期日の入力と区分の選択）があるまま閉じる（×、幕、Esc）か、別のストーリーや別の画面へ移る（beforeNavigate）ときは、
  // 捨てるかをアプリの中のダイアログで確かめる。帯の前後のボタンと `[` `]` で前後のストーリーへ移るとき（開いた画面が順を渡したときだけ）も、同じ確認を挟む。
  // 閉じた後に返った保存の応答も、通ったら木を読み直してトーストで知らせ、失敗はトーストで知らせる（saveFields）。
  // 帯の「⋯」（RowMenu）に、親を移す（MoveParentDialog。親のエピックは画面が渡す。通ったら読み直す）と、削除（TreeDeleteDialog。
  // 配下の扱いを選ぶ確認。配下が無ければ配下が無いことを出す）を置く。削除できない人（story-get の can_delete が偽）には、項目を出さず、
  // 本文の下に理由を出す（タスクの引き出しと同じ。項目が1つも無ければ「⋯」も出さない）。
  // 消したら閉じ、トーストで知らせ、画面が木を読み直す（onremoved）。
  // 完了の帯は、木に載っているストーリーのときだけ出す（facts。story-get は完了の状態を返さないため、画面が木から渡す）。
  // 木に載っていなければ（絞り込みの外、一覧の無い画面）、帯の位置に、操作を出せない理由を一文で出す。
  // 完了していなくて書けるときは「完了にする」（story-complete。確かめのダイアログは挟まない。配下の未完了のタスクが残るあいだと、
  // 親のエピックが完了か中止しているあいだは、木の行と同じく押せない理由を添えて aria-disabled）、
  // 完了していれば完了の印と日時と「取り消す」（story-reopen）。断られた理由は木の行と同じ文（completionFailureMessage）。
  // 通ったら木を読み直し、押したボタンは消えるので、完了の印か「完了にする」へフォーカスを移す
  let {
    mode = 'side',
    onmode,
    adjacent,
    onstep,
    slug,
    workspaceId,
    storyId,
    canWrite,
    facts,
    clock,
    parents,
    onclose,
    onchanged,
    onstale,
    onremoved,
  }: {
    mode?: TaskOpenMode;
    // 確認を通った後に呼ぶ。既定の保存は呼び出し側が行う。移れなかったとき（新しいタブを開けなかった）は false を返す
    onmode: (mode: TaskOpenMode) => boolean;
    // 開いた画面に今見えているストーリーの行の、前と次の ID（端では null）。渡さなければ前後のボタンとキーを使わない
    adjacent?: { prev: string | null; next: string | null };
    // 確認を通った後に、その ID のストーリーへ移る。移り終えるまで待てる値を返す（取り消されたら、この引き出しのまま続けられる）
    onstep?: (storyId: string) => Promise<void>;
    slug: string;
    workspaceId: string;
    storyId: string;
    canWrite: boolean;
    // 完了の状態（画面が木から渡す）。木に無いストーリーは null で、完了の帯を出さない
    facts: StoryFacts | null;
    // 期日の印を決める、ワークスペースの今日と週の始まり（画面が木から渡す）。無ければ印を出さない
    clock: { today: string; weekStart: number } | null;
    // 親に選べるエピック（完了も中止もしていないもの）。無ければ（木が無い）親を移すを出さない
    parents: readonly { id: string; title: string }[] | null;
    // 閉じる。画面の枠が `?story=` を外し、フォーカスを行へ戻す
    onclose: () => void;
    // 欄を保存した、完了にした、親を移した。画面が木だけを読み直す。読み直しが終わるまで待てる値を返してよい
    onchanged: () => Promise<void> | void;
    // ワークスペースの状態が変わっていた（閉じた）。画面が枠ごと読み直す
    onstale: () => void;
    // ストーリーが消えた（削除した、見つからない）。画面が閉じて、木を読み直す
    onremoved: () => void;
  } = $props();

  // この引き出しが開いたストーリーの ID。保存、完了、削除などの宛先は、props の storyId でなくこれを使う
  // （props は親の URL から読むので、引き出しが外れた後は null、前後へ移った後は次のストーリーの ID になる。枠が ID ごとに置き直すので、開いている間は変わらない）
  const openedId = untrack(() => storyId);

  const ids = $props.id();
  const titleLabelId = `${ids}-title`;
  const dueId = `${ids}-due`;
  const dueErrorId = `${ids}-due-error`;
  const categoryId = `${ids}-category`;
  const categoryErrorId = `${ids}-category-error`;
  const definitionsNoteId = `${ids}-definitions-note`;
  const readOnlyId = `${ids}-readonly`;
  const remainingId = `${ids}-remaining`;
  const reasonId = `${ids}-reason`;
  const blockedId = `${ids}-blocked`;

  // 期日を、選んでから保存するまでの待ち。年を打つ間と、矢印キーで動かす間の保存をまとめる
  const DUE_DEBOUNCE_MS = 600;
  // 期日の年が4桁そろったとみなす下限。打ちかけの年（0002、0020、0202）は、4桁の文字でも送らない
  const DUE_MIN_YEAR = 1000;

  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let story = $state<StoryDetail | null>(null);
  // 呼んだ人が削除できるか、まとめて削除できるか、配下のタスクの件数（story-get が返す）
  let canDelete = $state(false);
  let canDeleteChildren = $state(false);
  let childTasks = $state(0);
  let heading = $state<HTMLElement>();
  let retryButton = $state<HTMLButtonElement>();
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let deleteDialog = $state<ReturnType<typeof TreeDeleteDialog>>();
  let moveDialog = $state<ReturnType<typeof MoveParentDialog<{ id: string; title: string }>>>();

  // 直している途中の欄ごとの書きかけ（保存の要求を送っている間も数える）
  const dirty = $state({ title: false, acceptance: false, body: false, link: false });
  function hasDraft(): boolean {
    return dirty.title || dirty.acceptance || dirty.body || dirty.link || dueUnsent() || categoryChoice !== null;
  }

  let dueError = $state<string | null>(null);
  let dueInput = $state<HTMLInputElement>();
  let dueTimer: ReturnType<typeof setTimeout> | undefined;
  let dueSending = false;
  let dueAgain = false;
  // 期日の入力欄が、保存した値と同じ（同期済み）か、最後に送った値のときの文字。入力がこれと違えば、まだ送っていない入力がある
  let dueBase = '';
  let dueBoundTo: HTMLInputElement | undefined;
  // ほかの人が先に直していて断られた。書いた値を欄に残す（commitDue が読んで下ろす）
  let dueStale = false;
  // 断られた値。同じ値のままでは、欄を離れても待っても送り直さない（Enter か、値を替えたときに送る）
  let dueHeld: string | null = null;
  // ストーリーが消えていた。保存の続きを送らない
  let storyGone = false;
  let loadVersion = 0;

  // 部品が外れた後の応答で、状態を触らない
  let alive = true;
  $effect(() => () => {
    alive = false;
    clearTimeout(dueTimer);
    clearTimeout(categoryTimer);
  });

  // 捨てると決めた後、閉じる／移るために確認を飛ばす
  let leaving = false;
  let asking = false;

  // 前後のボタンで移ってきたときの、押した向き（TaskDrawer と同じ）
  const arrivedByStep = consumeStepFocus();
  let stepFocus = arrivedByStep;
  // 移った先のタイトルの読み上げ。ボタンで移ったときだけ入れる
  let movedStatus = $state('');

  const done = $derived(facts?.completedAt != null);
  const parentFinished = $derived(facts?.parentFinished === true);
  const remaining = $derived(facts?.openTasks ?? 0);
  const hasParent = $derived(story?.epic_id != null);

  // ---- 区分（親のないストーリーだけ。選んで少し待ってから、か欄を離れたときに保存する） ----
  // 選択肢は、直せるときだけ category-repository-list で読む。読めなければ、なしと今の値だけを選べる
  let definitions = $state<{ categories: DefinitionRef[] } | null>(null);
  let definitionsLoading = $state(false);
  let definitionsFailed = $state(false);
  let definitionsVersion = 0;
  // 選択欄で選んで、まだ送っていない区分（待っている間）と、送っている区分。空は区分なし
  let categoryChoice = $state<{ value: string } | null>(null);
  let categoryTimer: ReturnType<typeof setTimeout> | undefined;
  let categoryPending = $state<{ value: string } | null>(null);
  let categoryError = $state<string | null>(null);
  let categorySending = false;
  let categorySelect = $state<HTMLSelectElement>();
  // 自身に振った区分（親から引き継いだものは除く）
  const ownCategory = $derived(story?.category != null && !story.category.inherited ? story.category : null);
  const categoryShownId = $derived(
    categoryChoice !== null
      ? categoryChoice.value
      : categoryPending !== null
        ? categoryPending.value
        : (ownCategory?.id ?? ''),
  );
  const categoryOptions = $derived(withCurrent(definitions?.categories ?? [], ownCategory));
  // 選択欄の値を、見せる値に合わせる（保存に失敗して前の値へ戻すとき、選択肢が替わったとき）
  $effect(() => {
    const select = categorySelect;
    const value = categoryShownId;
    void categoryOptions;
    if (select != null && select.value !== value) select.value = value;
  });
  const categoryEditable = $derived(canWrite && story !== null && story.epic_id === null);

  async function loadDefinitions(): Promise<void> {
    const mine = ++definitionsVersion;
    definitionsLoading = true;
    const result = await callOperation(categoryRepositoryList, { workspace_id: workspaceId }, { slug });
    if (!alive || mine !== definitionsVersion) return;
    definitionsLoading = false;
    if (result.ok) {
      definitions = { categories: result.data.categories };
      definitionsFailed = false;
    } else {
      definitionsFailed = true;
    }
  }

  // 読み直す。読めたら、押したボタンは消えるので、区分の選択欄へフォーカスを移す
  async function retryDefinitions(): Promise<void> {
    if (definitionsLoading) return;
    await loadDefinitions();
    if (!alive || definitionsFailed) return;
    await tick();
    categorySelect?.focus();
  }

  function onCategoryChange(event: Event & { currentTarget: HTMLSelectElement }): void {
    categoryChoice = { value: event.currentTarget.value };
    clearTimeout(categoryTimer);
    categoryTimer = setTimeout(function wait() {
      if (asking) categoryTimer = setTimeout(wait, DUE_DEBOUNCE_MS);
      else if (!leaving) commitCategory();
    }, DUE_DEBOUNCE_MS);
  }

  function onCategoryBlur(): void {
    if (asking || leaving) return;
    commitCategory();
  }

  function commitCategory(): void {
    clearTimeout(categoryTimer);
    const choice = categoryChoice;
    if (choice === null) return;
    categoryChoice = null;
    categoryPending = { value: choice.value };
    if (!categorySending) void sendCategory();
  }

  // 送るのは1本ずつで、送っている間に選び直した分は最後の選択だけを送る。引き出しが閉じた後も、溜めた最後の選択まで送る
  async function sendCategory(): Promise<void> {
    categorySending = true;
    try {
      while (categoryPending !== null && !storyGone) {
        const choice = categoryPending.value;
        if (story === null || choice === (ownCategory?.id ?? '') || story.epic_id !== null) {
          categoryPending = null;
          break;
        }
        categoryError = null;
        const message = await saveFields({ category_id: choice === '' ? null : choice });
        if (message !== null) {
          categoryError = message;
          if (categoryPending === null || categoryPending.value === choice) categoryPending = null;
          continue;
        }
        if (categoryPending !== null && categoryPending.value === choice) categoryPending = null;
      }
      if (storyGone) categoryPending = null;
    } finally {
      categorySending = false;
    }
  }

  // ---- 読み込み ----
  async function load(): Promise<void> {
    const wantedStepFocus = stepFocus;
    stepFocus = null;
    const mine = ++loadVersion;
    loadState = 'loading';
    const result = await callOperation(storyGet, { workspace_id: workspaceId, story_id: openedId }, { slug });
    if (!alive || mine !== loadVersion) return;
    if (result.ok) {
      story = result.data.story;
      canDelete = result.data.can_delete;
      canDeleteChildren = result.data.can_delete_children;
      childTasks = result.data.children.tasks;
      loadState = 'ready';
      // 区分を直せるときだけ、選択肢を読む
      if (canWrite && result.data.story.epic_id === null && definitions === null) void loadDefinitions();
      // 開いたときの読み上げに、見出しが読まれるようにする。閉じるボタンか何も無い所にフォーカスがあるときだけ移す
      await tick();
      if (!alive) return;
      const active = document.activeElement;
      const idle = active === document.body || active?.classList.contains('drawer-close');
      if (wantedStepFocus !== null) {
        movedStatus = t('drawerMoved', { task: t('story'), title: result.data.story.title });
        const button = document.querySelector<HTMLElement>(`.drawer [data-drawer-step="${wantedStepFocus}"]`);
        if (button !== null && button.getAttribute('aria-disabled') !== 'true') {
          if (idle || active === button) button.focus();
          return;
        }
      }
      if (idle) heading?.focus();
      return;
    }
    if (result.status === 401) {
      onstale();
      return;
    }
    // 400 は、URL の `?story=` が ID の形でないとき。見つからないのと同じに扱う
    if (result.status === 404 || result.status === 400) {
      gone();
      return;
    }
    loadState = 'failed';
    // 失敗の文と「もう一度試す」へ、フォーカスを移す（開いたときの閉じるボタンに残さない）
    await tick();
    if (alive && mine === loadVersion) retryButton?.focus();
  }

  void load();

  // ストーリーが消えていた（別の人が削除した）。閉じて、木を読み直す
  function gone(): void {
    leaving = true;
    storyGone = true;
    showToast(t('storyGone', { story: t('story') }), 'alert');
    onremoved();
  }

  // 今の値を読み直す。読めなければ今の表示のまま（null）
  async function refresh(): Promise<StoryDetail | null> {
    const result = await callOperation(storyGet, { workspace_id: workspaceId, story_id: openedId }, { slug });
    if (!result.ok) return null;
    if (alive) {
      story = result.data.story;
      canDelete = result.data.can_delete;
      canDeleteChildren = result.data.can_delete_children;
      childTasks = result.data.children.tasks;
    }
    return result.data.story;
  }

  // ---- 閉じる、移る ----
  // 閉じる操作。書きかけがあれば、捨てるかを確かめる
  async function requestClose(): Promise<void> {
    if (asking || leaving) return;
    if (hasDraft() && !(await confirmDiscard())) return;
    leaving = true;
    onclose();
  }

  // 帯で形を押したとき。描いている形（shown）と同じなら既定だけ保存して終える。違えば、書きかけの確認の後に呼び出し側が移る
  async function requestMode(next: TaskOpenMode, shown: TaskOpenMode): Promise<void> {
    if (asking || leaving) return;
    if (pickTaskOpenMode(next, shown) === 'stay') return;
    if (hasDraft() && !(await confirmDiscard())) return;
    leaving = true;
    if (!onmode(next)) leaving = false;
  }

  // 前後のストーリーへ移る操作（帯のボタンと `[` `]`）。書きかけがあれば、閉じるときと同じ確認を挟む。
  // 移る先は確認の後に決め直す（確認の間に、順が替わったり、引き出しが閉じたりしうる）。
  // ボタンで移ったときだけ、移った先の引き出しが、押したのと同じ向きのボタンへフォーカスを戻す
  const stepTarget = (delta: -1 | 1) => (delta < 0 ? adjacent?.prev : adjacent?.next);

  async function requestStep(delta: -1 | 1, source: StepSource): Promise<void> {
    if (!onstep || !stepTarget(delta) || asking || leaving) return;
    if (hasDraft() && !(await confirmDiscard())) return;
    const target = stepTarget(delta);
    if (!alive || leaving || !target) return;
    leaving = true;
    if (source === 'button') markStepFocus(delta);
    await onstep(target);
    if (!alive) return;
    // 移れなかった（移動が取り消された）。この引き出しを続けられる状態に戻す
    clearStepFocus();
    leaving = false;
  }

  async function confirmDiscard(): Promise<boolean> {
    asking = true;
    try {
      return (await discardDialog?.ask()) ?? false;
    } finally {
      asking = false;
    }
  }

  // 別のストーリーや別の画面へ移るとき（戻る／進む、左のメニュー）も、書きかけがあれば確かめる。
  // 同じストーリーのままの移動と、閉じると決めた後は通す。ページを離れる（タブを閉じる、外のサイト）ときは、cancel() がブラウザの確認を出す。
  // 捨てると決めた後、戻る／進むは履歴をその分だけ動かす（goto は履歴を積んでしまう）
  beforeNavigate((navigation) => {
    if (leaving || !hasDraft()) return;
    if (navigation.to === null) {
      navigation.cancel();
      return;
    }
    const to = navigation.to.url;
    if (
      to.origin === location.origin &&
      to.pathname === location.pathname &&
      to.searchParams.get('story') === openedId
    ) {
      return;
    }
    const delta = navigation.type === 'popstate' ? navigation.delta : undefined;
    navigation.cancel();
    if (asking) return;
    void confirmDiscard().then((discard) => {
      if (!discard) return;
      leaving = true;
      if (to.origin !== location.origin) location.href = to.href;
      else if (delta !== undefined && delta !== 0) history.go(delta);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 行き先は SvelteKit が解決した URL（navigation.to）で、経路から作り直せない
      else void goto(to, { reset: to.pathname !== location.pathname });
    });
  });

  // ---- 保存 ----
  type Fields = Partial<
    Pick<StoryDetail, 'title' | 'acceptance_criteria_md' | 'body_md' | 'due_on' | 'link_url'> & {
      category_id: string | null;
    }
  >;
  // 書き始めた時点の値（保存の expected）。直している間に読み直しで別の人の値が入っても、黙って上書きしない。
  // 断られて読み直した後は、今の値に置き換える（読み直した内容を知らせた上で、続けて書くと上書きする）。
  // 空は空の文字（expected は入力の形）。書き始めていなければ undefined で、そのときは保存の時点の値を使う
  // 期日は、空を null で表す（story-update の expected の形）。期日の入力欄が保存した値に合わせるたびに、その値へ更新する（syncDue）
  type Expected = {
    title?: string;
    acceptance_criteria_md?: string;
    body_md?: string;
    link_url?: string;
    due_on?: string | null;
  };
  const bases: Expected = {};
  const AUTOSAVED = ['title', 'acceptance_criteria_md', 'body_md', 'link_url'] as const;

  // 欄を書く。成功なら null、失敗ならエラーの文。404 は閉じる側へ回す（文は返さず、storyGone を立てる）。
  // 引き出しが閉じた後に返った応答も、黙って捨てない: 通ったら木を読み直してトーストで知らせ、失敗はトーストで知らせる（画面の状態は触らない）。
  // 自動保存の欄（AutoSaveEdit。inline が真）は、保存の状態を欄の横に出すので、画面が残っている間はトーストを出さない。
  // 期日は expected を添えるが、欄の横の状態は無いので、区分と同じくトーストで知らせる（inline を偽にする）
  async function saveFields(
    fields: Fields,
    expected?: Expected,
    inline: boolean = expected !== undefined,
  ): Promise<string | null> {
    const result = await callOperation(
      storyUpdate,
      {
        workspace_id: workspaceId,
        story_id: openedId,
        ...fields,
        ...(expected === undefined ? {} : { expected }),
      },
      { slug },
    );
    if (result.ok) {
      if (alive && story !== null) {
        const saved = result.data.story;
        const merged: StoryDetail = { ...story, epic_id: saved.epic_id, category: saved.category };
        for (const key of Object.keys(fields) as (keyof Fields)[]) {
          if (key !== 'category_id') Object.assign(merged, { [key]: saved[key] });
        }
        story = merged;
      }
      // 続けて書くときの読んだ値は、今保存した値にする
      if (expected !== undefined) {
        for (const key of AUTOSAVED) if (key in fields) bases[key] = fields[key] ?? '';
      }
      if (!inline || !alive) showToast(t('taskSaved'), 'check');
      void onchanged();
      return null;
    }
    // 選んだ区分が削除されていた（ストーリーはある）。一覧を読み直して、選び直してもらう
    if (result.status === 404 && fields.category_id != null && (await refresh()) !== null) {
      if (alive) void loadDefinitions();
      const message = t('definitionRefGone', { kind: t('category') });
      if (!alive) showToast(message, 'alert');
      return message;
    }
    if (result.status === 404) {
      storyGone = true;
      if (alive) gone();
      else {
        showToast(t('storyGone', { story: t('story') }), 'alert');
        void onchanged();
      }
      return null;
    }
    let message: string;
    if (result.status === 401) {
      onstale();
      message = t('taskSaveFailed');
    } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
      // 閉じた。枠を読み直して、読み取り専用の表示に切り替える
      onstale();
      message = t('workspaceClosedReadOnly', { workspace: t('workspace') });
    } else if (result.status === 409) {
      message = await conflictMessage(result.error?.details);
    } else {
      message = result.status === 400 ? t('storyBadRequest') : t('taskSaveFailed');
    }
    // 自動保存の欄（inline）は、閉じた後の失敗を AutoSaveEdit がトーストで知らせる
    if (!alive && !inline) showToast(message, 'alert');
    return message;
  }

  // 409 の文。書き始めてからほかの人が先に同じ欄を直していれば、書いた分は欄に残し、今の値を並べて知らせる。
  // 次の保存は、今の値を読んだものとして送る。そうでなければ、区分を振れない（エピックの下へ移された）か、同時に直された
  async function conflictMessage(details: unknown): Promise<string> {
    await refresh();
    const stale = staleCurrentOf(details);
    // 引き出しが閉じた後は、書いた分を残す欄が無い。残してあるとは言わない
    if (stale !== null && !alive) return t('taskSaveRaced');
    if (stale !== null) {
      const key = AUTOSAVED.find((name) => name in stale);
      if (key !== undefined) {
        const now = stale[key];
        bases[key] = typeof now === 'string' ? now : '';
        return t('taskFieldStale', { current: excerpt(typeof now === 'string' ? now : '') });
      }
      if ('due_on' in stale) {
        const now = typeof stale.due_on === 'string' ? stale.due_on : null;
        bases.due_on = now;
        dueStale = true;
        return t('taskFieldStale', { current: now ?? t('dueUnset', { due: t('due') }) });
      }
    }
    if (categoryConflictReasonOf(details) === 'has_parent') {
      return t('categoryHasParent', { task: t('story'), category: t('category') });
    }
    return t('taskSaveRaced');
  }

  // 知らせに添える今の値は、長いと欄を押し出すので短くする
  function excerpt(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat === '' ? t('bodyEmpty') : flat;
  }

  // 描いた本文を押したら書く欄に替える。本文の中のリンクと、文字を選ぶ操作は、そのまま通す
  function beginFromSurface(event: MouseEvent, begin: (event: Event) => void): void {
    if (event.target instanceof Element && event.target.closest('a, button, summary, input')) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    begin(event);
  }

  function titleProblem(raw: string): string | null {
    const problem = storyTitleProblem(raw.trim());
    if (problem === 'required') return t('storyTitleRequired');
    if (problem === 'too_long') return t('storyTitleTooLong', { max: STORY_TITLE_MAX_LENGTH });
    if (problem === 'invalid_character') return t('storyTitleInvalidCharacter');
    return null;
  }

  function saveTitle(raw: string): Promise<string | null> {
    const next = raw.trim();
    return story === null || next === story.title
      ? Promise.resolve(null)
      : saveFields({ title: next }, { title: bases.title ?? story.title });
  }

  function linkProblemMessage(raw: string): string | null {
    const value = normalizeLinkUrl(raw);
    const problem = value === null ? null : linkUrlProblem(value);
    if (problem === 'too_long') return t('linkTooLong', { max: LINK_URL_MAX_LENGTH });
    if (problem === 'invalid_url') return t('linkInvalid');
    return null;
  }

  // 保存する形の文字（空は空、使える URL は解釈した URL）。書きかけの判定にも使う
  function linkForm(raw: string): string {
    const value = normalizeLinkUrl(raw);
    if (value === null) return '';
    return linkUrlProblem(value) === null ? canonicalLinkUrl(value) : value;
  }

  function saveLink(raw: string): Promise<string | null> {
    const value = normalizeLinkUrl(raw);
    return story === null || linkForm(raw) === (story.link_url ?? '')
      ? Promise.resolve(null)
      : saveFields({ link_url: value }, { link_url: bases.link_url ?? story.link_url ?? '' });
  }

  function textProblem(raw: string, field: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field, max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field });
    return null;
  }

  function saveAcceptance(raw: string): Promise<string | null> {
    const next = normalizeLongText(raw);
    return story === null || next === story.acceptance_criteria_md
      ? Promise.resolve(null)
      : saveFields(
          { acceptance_criteria_md: next },
          { acceptance_criteria_md: bases.acceptance_criteria_md ?? story.acceptance_criteria_md ?? '' },
        );
  }

  function saveBody(raw: string): Promise<string | null> {
    const next = normalizeLongText(raw);
    return story === null || next === story.body_md
      ? Promise.resolve(null)
      : saveFields({ body_md: next }, { body_md: bases.body_md ?? story.body_md ?? '' });
  }

  // ---- 期日（年が4桁そろった値だけを、待ってから、か欄を離れる／Enter で保存する） ----
  function dueIsComplete(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= DUE_MIN_YEAR;
  }

  function onDueChange(): void {
    clearTimeout(dueTimer);
    dueError = null;
    const value = dueInput?.value ?? '';
    // 打ちかけの年は送らない。欄を離れたときに、直っていなければ知らせる
    if (value !== '' && !dueIsComplete(value)) return;
    scheduleDue();
  }

  // 待ってから送る。捨てるかの確認を出している間は送らず、待ちを延ばす（捨てれば部品が外れて止まり、書き続ければ続きから送る）
  function scheduleDue(): void {
    clearTimeout(dueTimer);
    dueTimer = setTimeout(() => {
      if (asking) scheduleDue();
      else if (!leaving) void commitDue(false);
    }, DUE_DEBOUNCE_MS);
  }

  function onDueKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    clearTimeout(dueTimer);
    dueHeld = null;
    void commitDue(true);
  }

  function onDueBlur(): void {
    // 捨てるかの確認のダイアログにフォーカスが移ったときと、捨てると決めて部品が外れるときは、送らない
    if (asking || leaving) return;
    clearTimeout(dueTimer);
    void commitDue(true);
  }

  // 入力欄の値は、保存した値に追従させる。ただし、入力が最後に同期した（か送った）値のままのときだけ。
  // 送っている間に次の値を選んだ（入力が違う）ときは、先の応答で上書きしない
  // 送っている間は触らない（ほかの人が先に直していて断られたとき、書いた値を欄に残すため。送り終えた後に commitDue が合わせる）
  $effect(() => {
    const saved = story?.due_on ?? '';
    const input = dueInput;
    // 書き込めなくなって（終了が分かって）欄が外れると、bind:this は null になるので、null も外す
    if (input == null || dueSending) return;
    if (input !== dueBoundTo) {
      dueBoundTo = input;
      dueBase = input.value;
    }
    if (input.value === dueBase) {
      input.value = saved;
      dueBase = saved;
      // 書き始める前の値（保存の expected）。欄が保存した値に合っている間は、保存した値
      bases.due_on = story?.due_on ?? null;
    }
  });

  // まだ送っていない期日の入力がある（待っている間、打ちかけ、送っている間に選んだ次の値）
  function dueUnsent(): boolean {
    return dueInput != null && dueInput.value !== dueBase;
  }

  // final は、欄を離れたか Enter。書けない値のときだけ、ここで知らせる
  async function commitDue(final: boolean): Promise<void> {
    const input = dueInput;
    if (story === null || input == null || storyGone) return;
    if (dueSending) {
      dueAgain = true;
      return;
    }
    const value = input.value;
    // 途中までしか打たれていない値や存在しない日付は、value が空になり、validity.badInput が立つ
    if (input.validity.badInput || (value !== '' && !dueIsComplete(value))) {
      if (final) dueError = t('dueInvalid', { due: t('due') });
      return;
    }
    const next = value === '' ? null : value;
    if (next === story.due_on) {
      dueBase = value;
      dueHeld = null;
      return;
    }
    // ほかの人が先に直していて断られた値は、手を付けない間は送り直さない（読んだ上で上書きするなら、続けて書くか Enter）
    if (dueHeld === value) return;
    dueHeld = null;
    dueSending = true;
    dueBase = value;
    dueError = null;
    dueStale = false;
    try {
      const message = await saveFields(
        { due_on: next },
        { due_on: bases.due_on !== undefined ? bases.due_on : story.due_on },
        false,
      );
      if (message === null) {
        // 続けて書くときの読んだ値は、今保存した値にする
        bases.due_on = next;
      } else {
        dueError = message;
        if (dueStale) {
          // ほかの人が先に直していた。書いた値は欄に残し、保存した値（今の値）とは違うものとして数える。次の保存は、今の値を読んだものとして送る
          dueStale = false;
          if (alive && input.value === value) {
            dueHeld = value;
            dueBase = story?.due_on ?? '';
          }
        } else if (alive && input.value === value) {
          // 失敗したら、保存した値へ戻す。ただし、送っている間に打っている次の値は消さない
          input.value = story?.due_on ?? '';
          dueBase = input.value;
          bases.due_on = story?.due_on ?? null;
        }
      }
    } finally {
      dueSending = false;
    }
    // 送っている間に値が変わっていたら、送り終えた後に、今の値を送る
    if (dueAgain) {
      dueAgain = false;
      if (alive) await commitDue(true);
    }
  }

  function clearDue(): void {
    if (dueInput == null) return;
    clearTimeout(dueTimer);
    dueHeld = null;
    dueInput.value = '';
    // 「クリア」は空にすると消えるので、フォーカスを期日の入力欄へ移す
    dueInput.focus();
    void commitDue(true);
  }

  // ---- 完了にする、取り消す（確かめのダイアログは挟まない。1本だけ送る） ----
  let completing = $state(false);
  let reopening = $state(false);
  let doneMark = $state<HTMLElement>();
  let completeButton = $state<HTMLElement>();

  async function setCompletion(action: 'complete' | 'reopen'): Promise<void> {
    if (story === null || facts === null || completing || reopening) return;
    if (action === 'complete' ? done : !done) return;
    if (action === 'complete') completing = true;
    else reopening = true;
    try {
      const input = { workspace_id: workspaceId, story_id: openedId };
      const result =
        action === 'complete'
          ? await callOperation(storyComplete, input, { slug })
          : await callOperation(storyReopen, input, { slug });
      if (result.ok) {
        showToast(
          action === 'complete'
            ? t('storyCompleted', { story: t('story'), done: t('done') })
            : t('storyReopened', { story: t('story'), done: t('done') }),
          'check',
        );
        // 完了の状態は木から渡るので、木を読み直す。閉じた後に返った応答も、木は読み直す
        await onchanged();
      } else if (result.status === 401) {
        onstale();
        return;
      } else if (result.status === 404) {
        if (alive) gone();
        else {
          showToast(t('storyGone', { story: t('story') }), 'alert');
          void onchanged();
        }
        return;
      } else {
        const failure = completionFailureMessage(result, action);
        showToast(failure.message, 'alert');
        if (result.status === 409 && result.error?.code === 'workspace_closed') onstale();
        if (failure.reload) await onchanged();
        else return;
      }
    } finally {
      if (alive) {
        completing = false;
        reopening = false;
      }
    }
    // 押したボタンは消えるので、フォーカスを完了の印か「完了にする」へ移す
    await tick();
    if (alive) (facts?.completedAt != null ? doneMark : completeButton)?.focus();
  }

  // ---- 親を移す ----
  // 移す先の末尾に置く（API には直前の行を送らない）。通ったら読み直す（エピックの下へ移すと、区分は親から引き継ぐ）
  async function moveParent(item: { id: string; title: string }, epicId: string | null): Promise<void> {
    if (story === null) return;
    const result = await callOperation(
      storyMove,
      { workspace_id: workspaceId, story_id: item.id, epic_id: epicId },
      { slug },
    );
    if (result.ok) {
      showToast(t('storyParentMoved', { story: t('story') }), 'check');
      await refresh();
      // 親なしへ移すと、区分を選べるようになる。選択肢は、まだ読んでいなければ読む
      if (alive && canWrite && story?.epic_id === null && definitions === null && !definitionsLoading) {
        void loadDefinitions();
      }
      void onchanged();
      return;
    }
    if (result.status === 401) {
      onstale();
      return;
    }
    // 遅れて届いた応答で、今開いている別のストーリーの引き出しを閉じない
    if (result.status === 404) {
      if (alive) gone();
      else {
        showToast(t('storyGone', { story: t('story') }), 'alert');
        void onchanged();
      }
      return;
    }
    if (result.status === 409 && result.error?.code === 'workspace_closed') onstale();
    showToast(moveFailureMessage(result, 'story'), 'alert');
    if (result.status === 409) {
      await refresh();
      void onchanged();
    }
  }

  function askMoveParent(trigger: HTMLElement): void {
    if (story === null) return;
    moveDialog?.show(trigger, { id: story.id, title: story.title }, story.epic_id);
  }

  // ---- 削除 ----
  // 配下の扱いを選ぶ確認（TreeDeleteDialog）。件数とまとめて削除できるかは、確認が開いたときに story-get で読み直す
  function askDelete(trigger: HTMLElement): void {
    if (story === null || !canDelete) return;
    deleteDialog?.show(
      { kind: 'story', id: story.id, title: story.title, stories: 0, tasks: childTasks, canDeleteChildren },
      trigger,
    );
  }

  function deleteFinished(outcome: 'deleted' | 'gone' | 'closed'): void {
    if (outcome === 'closed') {
      onstale();
      return;
    }
    // 消えたので、書きかけがあっても確かめずに閉じる
    leaving = true;
    showToast(
      outcome === 'deleted' ? t('storyDeleted', { story: t('story') }) : t('storyGone', { story: t('story') }),
      outcome === 'deleted' ? 'check' : 'alert',
    );
    // 引き出しが外れた後（別のストーリーへ移った後）に届いたときは、今開いている引き出しを閉じず、木だけを読み直す
    if (alive) onremoved();
    else void onchanged();
  }

  const canMoveParent = $derived(canWrite && parents !== null && (hasParent || parents.length > 0));
  const menuItems = $derived.by(() => {
    const items = [];
    if (canMoveParent) {
      items.push({
        key: 'move-parent',
        label: t('moveParent'),
        icon: 'swap' as const,
        onselect: askMoveParent,
      });
    }
    // 削除できない人には、項目を出さず、理由を本文の下に出す（タスクの引き出しと同じ。項目に添えると、メニューの押せない項目の薄さで読みにくい）
    if (canDelete) {
      items.push({
        key: 'delete',
        label: t('storyDelete', { story: t('story') }),
        icon: 'trash' as const,
        danger: true,
        onselect: askDelete,
      });
    }
    return items;
  });

  const status = $derived(
    loadState === 'loading'
      ? t('loading')
      : completing
        ? t('storyCompleting', { done: t('done') })
        : reopening
          ? t('storyReopening', { done: t('done') })
          : '',
  );
</script>

{#snippet titleView(begin: ((event: Event) => void) | null)}
  <!-- tabindex="-1" は、開いたときに見出しへフォーカスを置くため（キーボードの Tab 順には入らない） -->
  <h2 class="drawer-title" tabindex="-1" bind:this={heading}>
    {#if begin !== null}
      <button class="edit-trigger" type="button" onclick={begin}>
        <span id={titleLabelId}>{story?.title}</span>
        <Icon name="pen" />
        <span class="visually-hidden">{t('taskTitleEditHint', { task: t('story') })}</span>
      </button>
    {:else}
      <span id={titleLabelId}>{story?.title}</span>
    {/if}
  </h2>
{/snippet}

{#snippet textView(source: string | null)}
  {#if source != null}
    <Markdown {source} headingStart={3} />
  {:else}
    <div class="doc-box is-empty">{t('bodyEmpty')}</div>
  {/if}
{/snippet}

{#snippet textField(
  label: string,
  value: string | null,
  problem: (raw: string) => string | null,
  save: (raw: string) => Promise<string | null>,
  ondirty: (dirty: boolean) => void,
  onbegin: (started: string) => void,
)}
  <div class="field">
    {#if canWrite}
      <AutoSaveEdit
        value={value ?? ''}
        {label}
        multiline
        hint={t('bodyEditHint')}
        {problem}
        {save}
        normalize={(raw) => normalizeLongText(raw) ?? ''}
        {ondirty}
        {onbegin}
      >
        {#snippet view(begin)}
          <span class="field-label">{label}</span>
          <!-- 描いた文そのものを押せば書ける。面いっぱいに透明なボタンを敷き、キーボードと読み上げの入口にする（中のリンクは上に重なり、押せるまま） -->
          <div class="edit-surface" onclick={(event) => beginFromSurface(event, begin)} role="presentation">
            <button class="edit-surface-button" type="button" onclick={begin}
              >{t('bodyEditLabel', { field: label })}</button
            >
            <div class="edit-surface-body">{@render textView(value)}</div>
          </div>
        {/snippet}
      </AutoSaveEdit>
    {:else}
      <span class="field-label">{label}</span>
      {@render textView(value)}
    {/if}
  </div>
{/snippet}

<Drawer
  {mode}
  modes={['side', 'center']}
  noun={t('story')}
  onmode={(next, shown) => void requestMode(next, shown)}
  adjacent={adjacent === undefined ? undefined : { hasPrev: adjacent.prev !== null, hasNext: adjacent.next !== null }}
  onstep={(delta, source) => void requestStep(delta, source)}
  initialFocus={arrivedByStep}
  labelledBy={titleLabelId}
  busy={loadState === 'loading'}
  onrequestclose={() => void requestClose()}
>
  {#snippet top()}
    <span class="chip"><Icon name="check" />{t('story')}</span>
    {#if done}<span class="chip is-ok"><Icon name="check" />{t('done')}</span>{/if}
    {#if canWrite && story !== null && menuItems.length > 0}
      <RowMenu title={story.title} items={menuItems} />
    {/if}
  {/snippet}

  {#if loadState === 'loading'}
    <!-- 読み上げは下の role="status" が伝えるので、見える文字だけにする -->
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('story')}</span></h2>
    <p class="field-hint" aria-hidden="true">{t('loading')}</p>
  {:else if loadState === 'failed'}
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('story')}</span></h2>
    <div class="callout is-danger" role="alert">
      <Icon name="alert" /><span>{t('storyLoadFailed', { story: t('story') })}</span>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" bind:this={retryButton} onclick={() => void load()}>{t('retry')}</button>
    </div>
  {:else if story !== null}
    {#if !canWrite}
      <div class="callout is-info" id={readOnlyId}>
        <Icon name="shield" /><span>{t('storyReadOnly', { workspace: t('workspace'), story: t('story') })}</span>
      </div>
    {/if}

    {#if canWrite}
      <AutoSaveEdit
        value={story.title}
        label={t('fieldTitle')}
        labelHidden
        placeholder={t('storyTitlePlaceholder')}
        problem={titleProblem}
        save={saveTitle}
        normalize={(raw) => raw.trim()}
        ondirty={(value) => (dirty.title = value)}
        onbegin={(started) => (bases.title = started)}
      >
        {#snippet view(begin)}{@render titleView(begin)}{/snippet}
      </AutoSaveEdit>
    {:else}
      {@render titleView(null)}
    {/if}

    <dl class="props">
      <div>
        <dt>
          {#if canWrite}<label for={dueId}>{t('due')}</label>{:else}{t('due')}{/if}
        </dt>
        <dd>
          {#if canWrite}
            <input
              class="input"
              id={dueId}
              type="date"
              bind:this={dueInput}
              onchange={onDueChange}
              onblur={onDueBlur}
              onkeydown={onDueKeydown}
              aria-invalid={dueError !== null}
              aria-describedby={dueError !== null ? dueErrorId : undefined}
            />
            {#if story.due_on !== null}
              <button class="link-btn" type="button" onclick={clearDue}>{t('dueClear')}</button>
            {/if}
          {:else}
            <!-- 読み取り専用では、入力欄にせず文字で出す（空は「—」） -->
            <span id={dueId}>{story.due_on ?? '—'}</span>
          {/if}
          <!-- 期限の印（木の行と同じ部品）。保存した値（story.due_on）で出し直す。完了したストーリーは色なし -->
          {#if story.due_on !== null && clock !== null}
            <DueChip dueOn={story.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
          {/if}
          {#if dueError !== null}
            <span class="field-error" id={dueErrorId} role="alert"><Icon name="alert" />{dueError}</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt>
          {#if categoryEditable}<label for={categoryId}>{t('category')}</label>{:else}{t('category')}{/if}
        </dt>
        <dd>
          {#if categoryEditable}
            <select
              class="select"
              id={categoryId}
              bind:this={categorySelect}
              onchange={onCategoryChange}
              onblur={onCategoryBlur}
              aria-busy={definitionsLoading}
              aria-invalid={categoryError !== null}
              aria-describedby={[
                definitionsFailed ? definitionsNoteId : null,
                categoryError !== null ? `${categoryId}-error` : null,
              ]
                .filter((id) => id !== null)
                .join(' ') || undefined}
            >
              <option value="" selected={categoryShownId === ''}
                >{t('categoryNone', { category: t('category') })}</option
              >
              {#each categoryOptions as option (option.id)}
                <option value={option.id} selected={option.id === categoryShownId}>{option.name}</option>
              {/each}
            </select>
            {#if definitionsLoading && !definitionsFailed}
              <!-- 選択肢を読んでいる間は、なしと今の値だけなので、まだ読んでいることを示す -->
              <span class="props-note" role="status">{t('loading')}</span>
            {/if}
            {#if definitionsFailed}
              <span class="props-note" id={definitionsNoteId}
                >{t('definitionsLoadFailed', { category: t('category') })}</span
              >
              <button
                class="btn is-sm is-quiet"
                type="button"
                aria-disabled={definitionsLoading}
                onclick={() => void retryDefinitions()}
              >
                {definitionsLoading ? t('retrying') : t('retry')}
              </button>
            {/if}
          {:else}
            <!-- 親から引き継いだ区分と、読み取り専用のときは文字で出す -->
            <span>{story.category?.name ?? t('categoryNone', { category: t('category') })}</span>
          {/if}
          {#if hasParent}
            <span class="props-note">{t('categoryInherited')}</span>
          {/if}
          {#if categoryError !== null}
            <span class="field-error" id={categoryErrorId} role="alert"><Icon name="alert" />{categoryError}</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt>{t('fieldLink')}</dt>
        <dd>
          {#if canWrite}
            <AutoSaveEdit
              value={story.link_url ?? ''}
              label={t('fieldLink')}
              labelHidden
              inputType="url"
              placeholder={t('linkPlaceholder')}
              problem={linkProblemMessage}
              save={saveLink}
              normalize={linkForm}
              ondirty={(value) => (dirty.link = value)}
              onbegin={(started) => (bases.link_url = started)}
            >
              {#snippet view(begin)}
                <button class="edit-trigger" class:is-empty={story?.link_url === null} type="button" onclick={begin}>
                  {#if story?.link_url != null}
                    <span class="source-key"><Icon name="link" /> {story.link_url}</span>
                  {:else}
                    <span>{t('linkAdd')}</span>
                  {/if}
                  <Icon name="pen" />
                  <span class="visually-hidden">{t('linkEditHint')}</span>
                </button>
                {#if story?.link_url != null}
                  <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める。直している間は、読む形ごと隠れる -->
                  <a
                    class="btn is-sm"
                    href={story.link_url}
                    target="_blank"
                    rel="external noopener noreferrer"
                    aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
                  >
                {/if}
              {/snippet}
            </AutoSaveEdit>
          {:else if story.link_url !== null}
            <span class="source-key"><Icon name="link" /> {story.link_url}</span>
            <a
              class="btn is-sm"
              href={story.link_url}
              target="_blank"
              rel="external noopener noreferrer"
              aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
            >
          {:else}
            —
          {/if}
        </dd>
      </div>
    </dl>

    {@render textField(
      t('ac'),
      story.acceptance_criteria_md,
      (raw) => textProblem(raw, t('ac')),
      saveAcceptance,
      (value) => (dirty.acceptance = value),
      (started) => (bases.acceptance_criteria_md = started),
    )}
    {@render textField(
      t('fieldBody'),
      story.body_md,
      (raw) => textProblem(raw, t('fieldBody')),
      saveBody,
      (value) => (dirty.body = value),
      (started) => (bases.body_md = started),
    )}

    <!-- 完了の帯（TaskDrawer と同じ .done-bar）。木に載っているストーリーのときだけ出す -->
    {#if facts !== null && (done || canWrite)}
      <div class="done-bar">
        {#if facts.completedAt !== null}
          <span class="done-bar-done">
            <!-- tabindex="-1" は、完了にした後にフォーカスを置くため（キーボードの Tab 順には入らない） -->
            <span class="hanko" role="img" aria-label={t('done')} tabindex="-1" bind:this={doneMark}
              ><Icon name="check" /><b>{t('doneStamp')}</b></span
            >
            <time datetime={facts.completedAt}
              >{t('taskCompletedAt', { done: t('done'), at: formatDateTime(facts.completedAt) })}</time
            >
            {#if canWrite}
              {#if parentFinished}
                <span class="props-note" id={blockedId}
                  >{t('storyReopenBlocked', { done: t('done'), epic: t('epic'), story: t('story') })}</span
                >
              {/if}
              <button
                class="link-btn"
                type="button"
                aria-label={t('storyReopenLabel', { done: t('done'), title: story.title })}
                aria-describedby={parentFinished ? blockedId : undefined}
                aria-disabled={reopening || parentFinished}
                onclick={() => {
                  if (!parentFinished) void setCompletion('reopen');
                }}>{t('storyReopen')}</button
              >
            {/if}
          </span>
        {:else}
          {#if parentFinished}
            <span class="props-note" id={blockedId}
              >{t('storyCompleteBlocked', { done: t('done'), epic: t('epic'), story: t('story') })}</span
            >
          {:else if remaining > 0}
            <span class="props-note" id={remainingId}>{t('storyRemaining', { count: remaining, task: t('task') })}</span
            >
            <span class="visually-hidden" id={reasonId}
              >{t('storyRemainingNote', { task: t('task'), done: t('done') })}</span
            >
          {/if}
          <button
            class="btn is-primary"
            type="button"
            aria-describedby={parentFinished ? blockedId : remaining > 0 ? `${remainingId} ${reasonId}` : undefined}
            aria-disabled={completing || parentFinished || remaining > 0}
            bind:this={completeButton}
            onclick={() => {
              if (!parentFinished && remaining === 0) void setCompletion('complete');
            }}
          >
            <Icon name="check" />{t('complete')}
          </button>
        {/if}
      </div>
    {:else if facts === null && canWrite}
      <!-- 木に載っていない（絞り込みの外、一覧の無い画面）ので、完了の操作は出せない。理由を帯の位置に伝える -->
      <div class="done-bar">
        <span class="props-note">{t('storyFactsMissing', { done: t('done') })}</span>
      </div>
    {/if}

    {#if canWrite && !canDelete}
      <!-- 削除できない人には、ボタンを出さず、理由を出す（タスクの引き出しと同じ） -->
      <div class="form-actions">
        <span class="field-hint">{t('taskDeleteWho', { leader: t('leader') })}</span>
      </div>
    {/if}
  {/if}

  <!-- 状態の読み上げの領域。常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
  <!-- 前後のボタンで移ったときだけ、移った先のタイトルを読み上げる（フォーカスは押したボタンに残るため） -->
  <span class="visually-hidden" role="status">{movedStatus}</span>
</Drawer>

<ConfirmDialog
  bind:this={discardDialog}
  title={t('discardTitle')}
  confirmLabel={t('discardConfirm')}
  cancelLabel={t('discardKeep')}
  danger
>
  <p>{t('discardText')}</p>
</ConfirmDialog>

{#if canWrite}
  <TreeDeleteDialog bind:this={deleteDialog} {slug} {workspaceId} onfinish={deleteFinished} />
  <MoveParentDialog
    bind:this={moveDialog}
    parents={parents ?? []}
    onmove={(item, epicId) => void moveParent(item, epicId)}
  />
{/if}
