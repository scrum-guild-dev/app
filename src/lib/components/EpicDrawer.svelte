<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { EPIC_TITLE_MAX_LENGTH, epicTitleProblem } from '../../shared/epic.ts';
  import { epicGet, epicUpdate, type EpicDetail } from '../../shared/operations/epic/index.ts';
  import { categoryRepositoryList, type DefinitionRef } from '../../shared/operations/definition/index.ts';
  import {
    LINK_URL_MAX_LENGTH,
    STORY_TEXT_MAX_LENGTH,
    canonicalLinkUrl,
    linkUrlProblem,
    longTextProblem,
    normalizeLinkUrl,
    normalizeLongText,
  } from '../../shared/story.ts';
  import { callOperation } from '../api.ts';
  import { withCurrent } from '../definition-options.ts';
  import { type TaskOpenMode, pickTaskOpenMode } from '../drawer.svelte.ts';
  import { staleCurrentOf } from '../story-drawer.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import AutoSaveEdit from './AutoSaveEdit.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Drawer from './Drawer.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import Markdown from './Markdown.svelte';
  import RowMenu from './RowMenu.svelte';
  import TreeDeleteDialog from './TreeDeleteDialog.svelte';

  // エピックの引き出しの中身（StoryDrawer のエピック版）。`?epic_id=<ID>` が付いている間、ワークスペースの枠（/[slug]/w/[id] のレイアウト）が置く。
  // 木のエピックの題と、エピックの画面の「<エピック>を直す」から開く。開いたら epic-get で1件を読む（本文は長いので、木には載せない）。
  // 読んでいる間は読み込み中を出し、読めなければ（404 以外）もう一度試すを出す（フォーカスもそこへ置く）。404 は、トーストで知らせて閉じ、画面が木を読み直す（onremoved）。
  // 欄ごとに、その場で直す。タイトル、本文、リンクは AutoSaveEdit（押したら書け、欄を離れるか手を止めると保存する。本文は Markdown の描画）。
  // 期日と区分は選んだら（期日は年が4桁そろった値だけを、少し待ってから、か欄を離れる／Enter で、区分は少し待ってから、か欄を離れたときに）保存する。
  // 送る欄は今の値と違うものだけで、保存したら、その欄だけを応答で入れ替え、画面が木とエピックの画面を読み直す（onchanged）。
  // 自動保存の欄と期日は、書き始めた時点の値（bases）を expected に添えて送る。先にほかの人が同じ欄を直していたら（409 の stale）、保存せずに
  // 今の値を並べて知らせ、書いた分は欄に残す（StoryDrawer と同じ）。区分は expected が無く、後の保存が勝つ。
  // 保存、削除の宛先は、開いたときのエピックの ID（openedId）。props の epicId は、閉じた後に替わる
  // エピックの本文には添付のファイルが無いので、Markdown の欄でなく、文字の欄にする
  // 区分は配下のストーリーとタスクが引き継ぐ。選択肢は、直せるときだけ category-repository-list で読む。
  // 依頼主、クリア報酬、討伐隊、クリアは、エピックの画面にある（引き出しの下の「<エピック>の画面を開く」から移る）。
  // 閉じたワークスペース（canWrite が偽）では、直す口と操作を出さず、読み取り専用で開く。
  // 書きかけ（タイトル、本文、リンクの直している途中で、保存と同じ整え方の後も値が保存した値と違うもの。保存の要求を送っている間も数える。
  // と、まだ送っていない期日の入力と区分の選択）があるまま閉じる（×、幕、Esc）か、別のエピックや別の画面へ移る（beforeNavigate）ときは、
  // 捨てるかをアプリの中のダイアログで確かめる。
  // 帯の「⋯」（RowMenu）に、削除（TreeDeleteDialog。配下の扱いを選ぶ確認。配下が無ければ配下が無いことを出す）を置く。
  // 削除できない人（epic-get の can_delete が偽）には、項目を出さず、本文の下に理由を出す（項目が1つも無ければ「⋯」も出さない）。
  // 消したら閉じ、トーストで知らせ、画面が木を読み直す（onremoved）
  let {
    mode = 'side',
    onmode,
    slug: slugProp,
    workspaceId: workspaceIdProp,
    epicId,
    canWrite,
    clock,
    finished,
    onclose,
    onchanged,
    onstale,
    onremoved,
  }: {
    mode?: TaskOpenMode;
    // 確認を通った後に呼ぶ。既定の保存は呼び出し側が行う
    onmode: (mode: TaskOpenMode) => boolean;
    slug: string;
    workspaceId: string;
    epicId: string;
    canWrite: boolean;
    // 期日の印を決める、ワークスペースの今日と週の始まり（画面が木から渡す）。無ければ印を出さない
    clock: { today: string; weekStart: number } | null;
    // エピックがクリアか中止している（画面が木から渡す。期日の印に色を付けない）。木に無ければ偽
    finished: boolean;
    // 閉じる。画面の枠が `?epic_id=` を外し、フォーカスを行へ戻す
    onclose: () => void;
    // 欄を保存した。画面が木とエピックの画面を読み直す。読み直しが終わるまで待てる値を返してよい
    onchanged: () => Promise<void> | void;
    // ワークスペースの状態が変わっていた（閉じた）。画面が枠ごと読み直す
    onstale: () => void;
    // エピックが消えた（削除した、見つからない）。画面が閉じて、木を読み直す
    onremoved: () => void;
  } = $props();

  // この引き出しが開いたエピックの ID。保存、削除などの宛先は、props の epicId でなくこれを使う
  // （props は親の URL から読むので、引き出しが外れた後は null になる。枠が ID ごとに置き直すので、開いている間は変わらない）
  const openedId = untrack(() => epicId);
  // slug と workspaceId も、開いたときの値を持つ（引き出しが外れた後の保存で、破棄済みの $derived を読まないため）
  const slug = untrack(() => slugProp);
  const workspaceId = untrack(() => workspaceIdProp);

  const ids = $props.id();
  const titleLabelId = `${ids}-title`;
  const dueId = `${ids}-due`;
  const dueErrorId = `${ids}-due-error`;
  const categoryId = `${ids}-category`;
  const categoryErrorId = `${ids}-category-error`;
  const definitionsNoteId = `${ids}-definitions-note`;
  const readOnlyId = `${ids}-readonly`;

  // 期日を、選んでから保存するまでの待ち。年を打つ間と、矢印キーで動かす間の保存をまとめる
  const DUE_DEBOUNCE_MS = 600;
  // 期日の年が4桁そろったとみなす下限。打ちかけの年（0002、0020、0202）は、4桁の文字でも送らない
  const DUE_MIN_YEAR = 1000;

  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let epic = $state<EpicDetail | null>(null);
  // 呼んだ人が削除できるか、まとめて削除できるか、配下の件数（epic-get が返す）
  let canDelete = $state(false);
  let canDeleteChildren = $state(false);
  let cleared = $state(false);
  let childCounts = $state({ stories: 0, tasks: 0 });
  let heading = $state<HTMLElement>();
  let retryButton = $state<HTMLButtonElement>();
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let deleteDialog = $state<ReturnType<typeof TreeDeleteDialog>>();

  // 直している途中の欄ごとの書きかけ（保存の要求を送っている間も数える）
  const dirty = $state({ title: false, body: false, link: false });
  function hasDraft(): boolean {
    return dirty.title || dirty.body || dirty.link || dueUnsent() || categoryChoice !== null;
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
  // エピックが消えていた。保存の続きを送らない
  let epicGone = false;
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

  const done = $derived(finished);

  // ---- 区分（選んで少し待ってから、か欄を離れたときに保存する。配下のストーリーとタスクが引き継ぐ） ----
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
  // 今の区分。epic-get は区分の ID だけを返すので、名前は選択肢から引く（一覧に無い、読めなかったときは、読めなかったことを名前にする）
  const ownCategory = $derived.by(() => {
    const id = epic?.category_id ?? null;
    if (id === null) return null;
    const known = definitions?.categories.find((option) => option.id === id);
    return known ?? { id, name: t('categoryCurrentUnread', { category: t('category') }) };
  });
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
  const categoryEditable = $derived(canWrite && epic !== null);

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
      while (categoryPending !== null && !epicGone) {
        const choice = categoryPending.value;
        if (epic === null || choice === (ownCategory?.id ?? '')) {
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
      if (epicGone) categoryPending = null;
    } finally {
      categorySending = false;
    }
  }

  // ---- 読み込み ----
  async function load(): Promise<void> {
    const mine = ++loadVersion;
    loadState = 'loading';
    const result = await callOperation(epicGet, { workspace_id: workspaceId, epic_id: openedId }, { slug });
    if (!alive || mine !== loadVersion) return;
    if (result.ok) {
      epic = result.data.epic;
      canDelete = result.data.can_delete;
      canDeleteChildren = result.data.can_delete_children;
      cleared = result.data.completed_at !== null;
      childCounts = result.data.children;
      loadState = 'ready';
      // 区分を直せるときだけ、選択肢を読む
      if (canWrite && definitions === null) void loadDefinitions();
      // 開いたときの読み上げに、見出しが読まれるようにする。閉じるボタンか何も無い所にフォーカスがあるときだけ移す
      await tick();
      if (!alive) return;
      const active = document.activeElement;
      const idle = active === document.body || active?.classList.contains('drawer-close');
      if (idle) heading?.focus();
      return;
    }
    if (result.status === 401) {
      onstale();
      return;
    }
    // 400 は、URL の `?epic_id=` が ID の形でないとき。見つからないのと同じに扱う
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

  // エピックが消えていた（別の人が削除した）。閉じて、木を読み直す
  function gone(): void {
    leaving = true;
    epicGone = true;
    showToast(t('epicGone', { epic: t('epic') }), 'alert');
    onremoved();
  }

  // 今の値を読み直す。読めなければ今の表示のまま（null）
  async function refresh(): Promise<EpicDetail | null> {
    const result = await callOperation(epicGet, { workspace_id: workspaceId, epic_id: openedId }, { slug });
    if (!result.ok) return null;
    if (alive) {
      epic = result.data.epic;
      canDelete = result.data.can_delete;
      canDeleteChildren = result.data.can_delete_children;
      cleared = result.data.completed_at !== null;
      childCounts = result.data.children;
    }
    return result.data.epic;
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

  async function confirmDiscard(): Promise<boolean> {
    asking = true;
    try {
      return (await discardDialog?.ask()) ?? false;
    } finally {
      asking = false;
    }
  }

  // 別のエピックや別の画面へ移るとき（戻る／進む、左のメニュー）も、書きかけがあれば確かめる。
  // 同じエピックのままの移動と、閉じると決めた後は通す。ページを離れる（タブを閉じる、外のサイト）ときは、cancel() がブラウザの確認を出す。
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
      to.searchParams.get('epic_id') === openedId
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
    Pick<EpicDetail, 'title' | 'body_md' | 'due_on' | 'link_url'> & {
      category_id: string | null;
    }
  >;
  // 書き始めた時点の値（保存の expected）。直している間に読み直しで別の人の値が入っても、黙って上書きしない。
  // 断られて読み直した後は、今の値に置き換える（読み直した内容を知らせた上で、続けて書くと上書きする）。
  // 空は空の文字（expected は入力の形）。書き始めていなければ undefined で、そのときは保存の時点の値を使う
  // 期日は、空を null で表す（epic-update の expected の形）。期日の入力欄が保存した値に合わせるたびに、その値へ更新する
  type Expected = {
    title?: string;
    body_md?: string;
    link_url?: string;
    due_on?: string | null;
  };
  const bases: Expected = {};
  const AUTOSAVED = ['title', 'body_md', 'link_url'] as const;

  // 欄を書く。成功なら null、失敗ならエラーの文。404 は閉じる側へ回す（文は返さず、epicGone を立てる）。
  // 引き出しが閉じた後に返った応答も、黙って捨てない: 通ったら木を読み直してトーストで知らせ、失敗はトーストで知らせる（画面の状態は触らない）。
  // 自動保存の欄（AutoSaveEdit。inline が真）は、保存の状態を欄の横に出すので、画面が残っている間はトーストを出さない。
  // 期日は expected を添えるが、欄の横の状態は無いので、区分と同じくトーストで知らせる（inline を偽にする）
  async function saveFields(
    fields: Fields,
    expected?: Expected,
    inline: boolean = expected !== undefined,
  ): Promise<string | null> {
    const result = await callOperation(
      epicUpdate,
      {
        workspace_id: workspaceId,
        epic_id: openedId,
        ...fields,
        ...(expected === undefined ? {} : { expected }),
      },
      { slug },
    );
    if (result.ok) {
      if (alive && epic !== null) {
        const saved = result.data.epic;
        const merged: EpicDetail = { ...epic, category_id: saved.category_id };
        for (const key of Object.keys(fields) as (keyof Fields)[]) {
          if (key !== 'category_id') Object.assign(merged, { [key]: saved[key] });
        }
        epic = merged;
      }
      // 続けて書くときの読んだ値は、今保存した値にする
      if (expected !== undefined) {
        for (const key of AUTOSAVED) if (key in fields) bases[key] = fields[key] ?? '';
      }
      if (!inline || !alive) showToast(t('taskSaved'), 'check');
      void onchanged();
      return null;
    }
    // 選んだ区分が削除されていた（エピックはある）。一覧を読み直して、選び直してもらう
    if (result.status === 404 && fields.category_id != null && (await refresh()) !== null) {
      if (alive) void loadDefinitions();
      const message = t('definitionRefGone', { kind: t('category') });
      if (!alive) showToast(message, 'alert');
      return message;
    }
    if (result.status === 404) {
      epicGone = true;
      if (alive) gone();
      else {
        showToast(t('epicGone', { epic: t('epic') }), 'alert');
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
      message = result.status === 400 ? t('epicBadRequest') : t('taskSaveFailed');
    }
    // 自動保存の欄（inline）は、閉じた後の失敗を AutoSaveEdit がトーストで知らせる
    if (!alive && !inline) showToast(message, 'alert');
    return message;
  }

  // 409 の文。書き始めてからほかの人が先に同じ欄を直していれば、書いた分は欄に残し、今の値を並べて知らせる。
  // 次の保存は、今の値を読んだものとして送る。そうでなければ、同時に直された
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
    return t('taskSaveRaced');
  }

  // 知らせに添える今の値は、長いと欄を押し出すので短くする
  function excerpt(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat === '' ? t('bodyEmpty') : flat;
  }

  function titleProblem(raw: string): string | null {
    const problem = epicTitleProblem(raw.trim());
    if (problem === 'required') return t('epicTitleRequired');
    if (problem === 'too_long') return t('epicTitleTooLong', { max: EPIC_TITLE_MAX_LENGTH });
    if (problem === 'invalid_character') return t('epicTitleInvalidCharacter');
    return null;
  }

  function saveTitle(raw: string): Promise<string | null> {
    const next = raw.trim();
    return epic === null || next === epic.title
      ? Promise.resolve(null)
      : saveFields({ title: next }, { title: bases.title ?? epic.title });
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
    return epic === null || linkForm(raw) === (epic.link_url ?? '')
      ? Promise.resolve(null)
      : saveFields({ link_url: value }, { link_url: bases.link_url ?? epic.link_url ?? '' });
  }

  function textProblem(raw: string, field: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field, max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field });
    return null;
  }

  function saveBody(raw: string): Promise<string | null> {
    const next = normalizeLongText(raw);
    return epic === null || next === epic.body_md
      ? Promise.resolve(null)
      : saveFields({ body_md: next }, { body_md: bases.body_md ?? epic.body_md ?? '' });
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
    const saved = epic?.due_on ?? '';
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
      bases.due_on = epic?.due_on ?? null;
    }
  });

  // まだ送っていない期日の入力がある（待っている間、打ちかけ、送っている間に選んだ次の値）
  function dueUnsent(): boolean {
    return dueInput != null && dueInput.value !== dueBase;
  }

  // final は、欄を離れたか Enter。書けない値のときだけ、ここで知らせる
  async function commitDue(final: boolean): Promise<void> {
    const input = dueInput;
    if (epic === null || input == null || epicGone) return;
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
    if (next === epic.due_on) {
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
        { due_on: bases.due_on !== undefined ? bases.due_on : epic.due_on },
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
            dueBase = epic?.due_on ?? '';
          }
        } else if (alive && input.value === value) {
          // 失敗したら、保存した値へ戻す。ただし、送っている間に打っている次の値は消さない
          input.value = epic?.due_on ?? '';
          dueBase = input.value;
          bases.due_on = epic?.due_on ?? null;
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

  // 描いた本文を押したら書く欄に替える。本文の中のリンクと、文字を選ぶ操作は、そのまま通す
  function beginFromSurface(event: MouseEvent, begin: (event: Event) => void): void {
    if (event.target instanceof Element && event.target.closest('a, button, summary, input')) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    begin(event);
  }

  // ---- 削除 ----
  // 配下の扱いを選ぶ確認（TreeDeleteDialog）。件数とまとめて削除できるかは、確認が開いたときに epic-get で読み直す
  function askDelete(trigger: HTMLElement): void {
    if (epic === null || !canDelete) return;
    deleteDialog?.show(
      { kind: 'epic', id: epic.id, title: epic.title, ...childCounts, canDeleteChildren, cleared },
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
      outcome === 'deleted' ? t('epicDeleted', { epic: t('epic') }) : t('epicGone', { epic: t('epic') }),
      outcome === 'deleted' ? 'check' : 'alert',
    );
    if (alive) onremoved();
    else void onchanged();
  }

  const menuItems = $derived.by(() => {
    const items = [];
    // 削除できない人には、項目を出さず、理由を本文の下に出す（タスクの引き出しと同じ）
    if (canDelete) {
      items.push({
        key: 'delete',
        label: t('epicDelete', { epic: t('epic') }),
        icon: 'trash' as const,
        danger: true,
        onselect: askDelete,
      });
    }
    return items;
  });

  // エピックの画面へのリンク。その画面の上で開いているときは出さない
  const epicPageHref = $derived(resolve('/[slug]/w/[id]/epics/[epicId]', { slug, id: workspaceId, epicId: openedId }));
  const onEpicPage = $derived(page.params.epicId !== undefined);

  const status = $derived(loadState === 'loading' ? t('loading') : '');
</script>

{#snippet titleView(begin: ((event: Event) => void) | null)}
  <!-- tabindex="-1" は、開いたときに見出しへフォーカスを置くため（キーボードの Tab 順には入らない） -->
  <h2 class="drawer-title" tabindex="-1" bind:this={heading}>
    {#if begin !== null}
      <button class="edit-trigger" type="button" onclick={begin}>
        <span id={titleLabelId}>{epic?.title}</span>
        <Icon name="pen" />
        <span class="visually-hidden">{t('taskTitleEditHint', { task: t('epic') })}</span>
      </button>
    {:else}
      <span id={titleLabelId}>{epic?.title}</span>
    {/if}
  </h2>
{/snippet}

{#snippet textView(source: string)}
  {#if source !== ''}
    <Markdown {source} headingStart={3} />
  {:else}
    <div class="doc-box is-empty">{t('bodyEmpty')}</div>
  {/if}
{/snippet}

<Drawer
  {mode}
  modes={['side', 'center']}
  noun={t('epic')}
  onmode={(next, shown) => void requestMode(next, shown)}
  labelledBy={titleLabelId}
  busy={loadState === 'loading'}
  onrequestclose={() => void requestClose()}
>
  {#snippet top()}
    <span class="chip"><Icon name="flag" />{t('epic')}</span>
    {#if canWrite && epic !== null && menuItems.length > 0}
      <RowMenu title={epic.title} items={menuItems} />
    {/if}
  {/snippet}

  {#if loadState === 'loading'}
    <!-- 読み上げは下の role="status" が伝えるので、見える文字だけにする -->
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('epic')}</span></h2>
    <p class="field-hint" aria-hidden="true">{t('loading')}</p>
  {:else if loadState === 'failed'}
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('epic')}</span></h2>
    <div class="callout is-danger" role="alert">
      <Icon name="alert" /><span>{t('epicLoadFailed', { epic: t('epic') })}</span>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" bind:this={retryButton} onclick={() => void load()}>{t('retry')}</button>
    </div>
  {:else if epic !== null}
    {#if !canWrite}
      <div class="callout is-info" id={readOnlyId}>
        <Icon name="shield" /><span>{t('epicReadOnly', { workspace: t('workspace'), epic: t('epic') })}</span>
      </div>
    {/if}

    {#if canWrite}
      <AutoSaveEdit
        value={epic.title}
        label={t('fieldTitle')}
        labelHidden
        placeholder={t('epicTitlePlaceholder')}
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
            {#if epic.due_on !== null}
              <button class="link-btn" type="button" onclick={clearDue}>{t('dueClear')}</button>
            {/if}
          {:else}
            <!-- 読み取り専用では、入力欄にせず文字で出す（空は「—」） -->
            <span id={dueId}>{epic.due_on ?? '—'}</span>
          {/if}
          <!-- 期限の印（木の行と同じ部品）。保存した値（epic.due_on）で出し直す。クリアか中止したエピックは色なし -->
          {#if epic.due_on !== null && clock !== null}
            <DueChip dueOn={epic.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
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
            <!-- 読み取り専用のときは文字で出す。名前は一覧から引くので、読み取り専用では今の区分が読めたときだけ出す -->
            <span>{ownCategory?.name ?? t('categoryNone', { category: t('category') })}</span>
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
              value={epic.link_url ?? ''}
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
                <button class="edit-trigger" class:is-empty={epic?.link_url === null} type="button" onclick={begin}>
                  {#if epic?.link_url != null}
                    <span class="source-key"><Icon name="link" /> {epic.link_url}</span>
                  {:else}
                    <span>{t('linkAdd')}</span>
                  {/if}
                  <Icon name="pen" />
                  <span class="visually-hidden">{t('linkEditHint')}</span>
                </button>
                {#if epic?.link_url != null}
                  <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める。直している間は、読む形ごと隠れる -->
                  <a
                    class="btn is-sm"
                    href={epic.link_url}
                    target="_blank"
                    rel="external noopener noreferrer"
                    aria-label={t('epicLinkOpenLabel')}>{t('epicLinkOpen')}</a
                  >
                {/if}
              {/snippet}
            </AutoSaveEdit>
          {:else if epic.link_url !== null}
            <span class="source-key"><Icon name="link" /> {epic.link_url}</span>
            <a
              class="btn is-sm"
              href={epic.link_url}
              target="_blank"
              rel="external noopener noreferrer"
              aria-label={t('epicLinkOpenLabel')}>{t('epicLinkOpen')}</a
            >
          {:else}
            —
          {/if}
        </dd>
      </div>
    </dl>

    <div class="field">
      {#if canWrite}
        <AutoSaveEdit
          value={epic.body_md ?? ''}
          label={t('fieldBody')}
          multiline
          hint={t('bodyEditHint')}
          problem={(raw) => textProblem(raw, t('fieldBody'))}
          save={saveBody}
          normalize={(raw) => normalizeLongText(raw) ?? ''}
          ondirty={(value) => (dirty.body = value)}
          onbegin={(started) => (bases.body_md = started)}
        >
          {#snippet view(begin)}
            <span class="field-label">{t('fieldBody')}</span>
            <!-- 描いた文そのものを押せば書ける。面いっぱいに透明なボタンを敷き、キーボードと読み上げの入口にする（中のリンクは上に重なり、押せるまま） -->
            <div class="edit-surface" onclick={(event) => beginFromSurface(event, begin)} role="presentation">
              <button class="edit-surface-button" type="button" onclick={begin}
                >{t('bodyEditLabel', { field: t('fieldBody') })}</button
              >
              <div class="edit-surface-body">{@render textView(epic?.body_md ?? '')}</div>
            </div>
          {/snippet}
        </AutoSaveEdit>
      {:else}
        <span class="field-label">{t('fieldBody')}</span>
        {@render textView(epic.body_md ?? '')}
      {/if}
    </div>

    <!-- 討伐隊、報酬、依頼主、クリアは、エピックの画面にある。その画面の上で開いているときは出さない -->
    {#if !onEpicPage}
      <div class="form-actions">
        <a class="btn" href={epicPageHref}><Icon name="flag" />{t('epicOpenPage', { epic: t('epic') })}</a>
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
{/if}
