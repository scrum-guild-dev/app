<script lang="ts">
  import { tick } from 'svelte';
  import { beforeNavigate, goto, invalidate } from '$app/navigation';
  import {
    taskTodayMark,
    taskTodayMarkConflictReasonOf,
    taskAssign,
    taskComplete,
    taskDelete,
    taskDetail,
    taskHistory,
    taskReopen,
    taskReopenConflictReasonOf,
    taskUpdate,
    type TaskDetail,
    type TaskFieldValue,
    type TaskHistoryEntry,
  } from '../../shared/operations/task/index.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { memberList } from '../../shared/operations/workspace/index.ts';
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
  import { TASK_POINT_VALUES, TASK_TITLE_MAX_LENGTH, taskTitleProblem } from '../../shared/task.ts';
  import { callOperation } from '../api.ts';
  import { withCurrent } from '../definition-options.ts';
  import {
    clearStepFocus,
    consumeStepFocus,
    markStepFocus,
    pickTaskOpenMode,
    type AdjacentTasks,
    type StepSource,
    type TaskOpenMode,
  } from '../drawer.svelte.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { completedMessage, sprintLabel, sprintPeriod } from '../sprint-label.ts';
  import { historyEntryView } from '../task-history.ts';
  import { pauseToast, showToast } from '../toast.svelte.ts';
  import { announceRemoved, type RestoreTarget } from '../task-removal.ts';
  import { t } from '../vocabulary.svelte.ts';
  import TodayMarkButton from './TodayMarkButton.svelte';
  import FavoriteButton from './FavoriteButton.svelte';
  import Avatar from './Avatar.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Drawer from './Drawer.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import AutoSaveEdit from './AutoSaveEdit.svelte';
  import { attachmentSaveFailure } from '../attachment-save.ts';
  import Markdown from './Markdown.svelte';
  import RepositoryPicker from './RepositoryPicker.svelte';
  import TaskComments from './TaskComments.svelte';
  import TaskFieldValues from './TaskFieldValues.svelte';
  import TaskThanks from './TaskThanks.svelte';

  // タスクの詳細の引き出しの中身（kit.js の drawerHtml）。`?task=<ID>` が付いている間、画面の枠（/[slug]/w/[id] のレイアウト）が置く。
  // 開いたら task-detail で1件を読む（本文は長いので、木には載せない）。読んでいる間は読み込み中を出し、読めなければ
  // （404 以外）もう一度試すを出す（フォーカスもそこへ置く）。404 は、トーストで知らせて閉じ、画面が木を読み直す（onremoved）。
  // ワークスペースの決まった欄は、属性の下、本文の前に欄ごとに並べる（TaskFieldValues。値は Markdown で、書かれていなければ
  // 完了していないタスクだけ「未記入」の印を添える。task-detail の fields を読み、保存は task-field-set で、読んだ値のままなら書き、
  // 同時に直されていれば断って読み直す）。
  // 欄ごとに、その場で直す。ポイントと期日は選んだら保存し、タイトル、リンク、本文は AutoSaveEdit で確定する（本文は Markdown の部品で描く）。
  // 送る欄は、今の値と違うものだけ。保存したら、その欄だけを応答で入れ替え、画面が木を読み直す（onchanged）。
  // ポイントの保存は1本ずつ送る。送っている間に選び直したら、最後の選択だけを溜め、送り終えた後に送る（矢印キーで動かしても要求が飛び交わず、
  // 応答の順が前後しない）。期日は、年が4桁そろった値だけを、少し待ってから（カレンダーで選んだとき）か、欄を離れる／Enter で保存する。
  // 担当は、アバターと選択欄で、選んで少し待ってから（閉じた選択欄の矢印キーは1つ動くたびに change を出すため）か、欄を離れたときに、
  // 最後の値だけを task-assign で保存する（期日と同じく、待っている間は書きかけに数える。送るのは1本ずつで、送っている間に選び直した分は
  // 最後の選択だけを送る）。選択欄を出している間は、名前を選択欄が読むので、アバターは読み上げから外す。
  // 候補は、読み込めた後に member-list の members（今所属している人）を読む。今の担当が候補にいない（抜けた）ときは、
  // その人を「名前（離脱済み）」の選択肢として残す。候補を読めなければ、担当なしと今の担当だけを選べ、読めなかったことと「もう一度試す」を添える。
  // 完了したタスクの担当は替えない（アバターと名前だけにして理由を添える）。
  // 完了したタスクのポイントは直せない（欄を読み取り専用にして理由を添える）。取り込んだタスクのタイトルとリンクと削除も直せない。
  // 閉じたワークスペース（canWrite が偽）では、直す口と削除を出さず、読み取り専用で開く。
  // 書きかけ（タイトル、リンク、本文の直している途中で、保存と同じ整え方の後も値が保存した値と違うもの。保存の要求を送っている間も数える。
  // と、まだ送っていない期日の入力）があるまま閉じる（×、幕、Esc）か、別のタスクや別の画面へ移る（beforeNavigate）ときは、
  // 捨てるかをアプリの中のダイアログで確かめる。捨てると決めたら、閉じる／移る。送っている最中の要求は止められず、そのまま通る。
  // 帯の前後のボタンと `[` `]` で前後のタスクへ移るとき（開いた画面が順を渡したときだけ。adjacent）も、同じ確認を挟む。
  // 閉じた後に返った保存の応答も、通ったら木を読み直してトーストで知らせ、失敗はトーストで知らせる（saveFields）。
  // 引き出しが読み直すのは木（onchanged）かワークスペースの枠（onstale）だけで、組織の枠は読み直さない。
  // 削除は確認のダイアログを挟まない。消したら閉じ、「取り消す」付きのトーストで知らせ（押すと task-restore を送って木を読み直す）、
  // 画面が木を読み直す（onremoved）。
  // 完了の帯の下に「コメント N」と「変更の履歴」のタブを置く（kit.js の drawerHtml）。初めはコメントのタブを選び、
  // タブの中身は外さずに隠す（書きかけのコメントを、タブを切り替えても保つ）。コメントは TaskComments が読み書きし、
  // 書きかけ（新しいコメントの欄の文字と、直している途中のコメント）を hasDraft に足す。
  // 「変更の履歴」は task-history で読む（新しい順に 50 件ずつで、続きは「さらに読む」で足す）。
  // 読み込めたときと、引き出しで保存した後に読み直す。列の名前と値の文は src/lib/task-history.ts が辞書の言葉で作る。
  // 本文の下に完了の帯（.done-bar）を置く。完了していなくて書けるときは「完了にする」（task-complete。確かめのダイアログは挟まない）、
  // 完了していれば完了の印と完了した日時を出し、横にワークスペースの完成の定義（空なら出さない）を Markdown で出す。
  // 完了にしたら、応答の日時を入れ、詳細と履歴を読み直し、画面が木を読み直す（onchanged）。押したボタンは消えるので、印へフォーカスを移す。
  // 完了していて戻せる（task-detail の reopenable）ときは、日時の横に「戻す」（.link-btn。task-reopen。確かめのダイアログは挟まない）。
  // 戻したら、詳細と履歴を読み直し、画面が木を読み直す。押したボタンは消えるので、「完了にする」へフォーカスを移す
  let {
    mode = 'side',
    onmode,
    adjacent,
    onstep,
    slug,
    workspaceId,
    currentUserId,
    taskId,
    canWrite,
    workspaceClosed = false,
    definitionOfDone,
    onclose,
    onchanged,
    onstale,
    onremoved,
    onrestored,
    onskipped,
  }: {
    mode?: TaskOpenMode;
    // 確認を通った後に呼ぶ。既定の保存は呼び出し側が行う。移れなかったとき（新しいタブを開けなかった）は false を返す
    onmode: (mode: TaskOpenMode) => boolean;
    // 開いた画面に今見えているタスクの行の、前と次の ID（端では null）。渡さなければ前後のボタンとキーを使わない（ページ全体など）
    adjacent?: AdjacentTasks;
    // 確認を通った後に、その ID のタスクへ移る。移り終えるまで待てる値を返す（取り消されたら、この引き出しのまま続けられる）
    onstep?: (taskId: string) => Promise<void>;
    slug: string;
    workspaceId: string;
    currentUserId: string | null;
    taskId: string;
    canWrite: boolean;
    workspaceClosed?: boolean;
    // ワークスペースの完成の定義（Markdown）。空なら null で、完了の操作の横に何も出さない
    definitionOfDone: string | null;
    // 閉じる。画面の枠が `?task=` を外し、フォーカスを行へ戻す
    onclose: () => void;
    // 欄を保存した。画面が木だけを読み直す（枠の読み直しが一時的に失敗しても、引き出しと書きかけを失わないため）
    onchanged: () => void;
    // ワークスペースの状態が変わっていた（閉じた）。画面が枠ごと読み直す
    onstale: () => void;
    // タスクが消えた（削除した、見つからない）。画面が閉じて、木を読み直す。キーボードで削除したときだけ、消した知らせのトーストの
    // ID を渡す（画面が、木を読み直してフォーカスを見出しへ移した後に、そのトーストの「取り消す」へフォーカスを移すため。
    // 消えて閉じたときと、マウスで削除したときは null）。cause は、このセッションで削除した（deleted）か、先に消えていた（gone。404）か
    onremoved: (toastId: number | null, cause: 'deleted' | 'gone') => void;
    // 「取り消す」で戻した。画面が木を読み直す。focus が真なら（押したボタンにフォーカスがあったとき）、戻したタスクの題のリンクへ
    // （無ければ見出しへ）フォーカスを移す。渡さなければ onchanged で読み直すだけ（ページ全体など）
    onrestored?: (taskId: string, focus: boolean) => Promise<void>;
    // フォーカスがあるトーストを Esc で閉じた。画面が、消した行の近い所へフォーカスを移す。near は削除を送る前の前後の行（渡さなければ null）
    onskipped?: (near: AdjacentTasks | null) => void;
  } = $props();

  const ids = $props.id();
  const titleLabelId = `${ids}-title`;
  const pointsLabelId = `${ids}-points`;
  const pointsReasonId = `${ids}-points-reason`;
  const pointsErrorId = `${ids}-points-error`;
  const dueId = `${ids}-due`;
  const dueErrorId = `${ids}-due-error`;
  const assigneeId = `${ids}-assignee`;
  const assigneeNoteId = `${ids}-assignee-note`;
  const assigneeErrorId = `${ids}-assignee-error`;
  const readOnlyId = `${ids}-readonly`;
  const repositoryLabelId = `${ids}-repository`;
  const repositoryErrorId = `${ids}-repository-error`;
  const definitionsNoteId = `${ids}-definitions-note`;
  const categoryId = `${ids}-category`;
  const categoryErrorId = `${ids}-category-error`;
  const commentsTabId = `${ids}-comments-tab`;
  const commentsPanelId = `${ids}-comments`;
  const historyTabId = `${ids}-history-tab`;
  const historyPanelId = `${ids}-history`;
  const dodHeadingId = `${ids}-dod`;

  type PointsChoice = (typeof TASK_POINT_VALUES)[number] | null;
  // 先頭が「未」（未見積もり）
  const pointChoices: readonly PointsChoice[] = [null, ...TASK_POINT_VALUES];

  // 期日を、選んでから保存するまでの待ち。年を打つ間と、矢印キーで動かす間の保存をまとめる
  const DUE_DEBOUNCE_MS = 600;
  // 期日の年が4桁そろったとみなす下限。打ちかけの年（0002、0020、0202）は、4桁の文字でも送らない
  const DUE_MIN_YEAR = 1000;

  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let task = $state<TaskDetail | null>(null);
  let taskContext = $state<Pick<OutputOf<typeof taskDetail>, 'column' | 'story' | 'epic' | 'today_on'>>({
    column: null,
    story: null,
    epic: null,
    today_on: null,
  });
  let marking = $state(false);
  let assigneeVersion = 0;
  let savedVersion = 0;
  let refreshVersion = 0;
  let latestRefresh: Promise<TaskDetail | null> | null = null;
  let latestRefreshTaskId: string | null = null;
  let refreshCloseIfGone = false;
  const todayReasonId = `${ids}-today-reason`;

  async function toggleToday() {
    if (marking || todayDisabledReason !== null || task === null) return;
    const requestedTaskId = taskId;
    const requestedAssigneeVersion = assigneeVersion;
    marking = true;
    try {
      const result = await callOperation(
        taskTodayMark,
        { workspace_id: workspaceId, task_id: requestedTaskId, marked: taskContext.today_on === null },
        { slug },
      );
      if (result.ok) {
        // 保存済みの印は直ちに反映する。ただし、その間に担当変更が成功して印を消した応答より前へ戻さない。
        if (alive && taskId === requestedTaskId) {
          if (requestedAssigneeVersion === assigneeVersion)
            taskContext = { ...taskContext, today_on: result.data.today_on };
          const latest = await refresh(true);
          if (latest === null && alive && taskId === requestedTaskId && !taskGone)
            showToast(t('todayMarkRefreshFailed'), 'alert');
        }
        onchanged();
        await invalidate('app:today');
      } else {
        if (result.status === 409 || result.status === 404) {
          if (taskId === requestedTaskId) await refresh(true);
          onchanged();
          await invalidate('app:today');
          if (result.error?.code === 'workspace_closed') onstale();
        }
        // 削除済みなら gone() が知らせる。競合では、読み直した状態と断られた理由を伝える。
        if (!taskGone) {
          const reason = taskTodayMarkConflictReasonOf(result.error?.details);
          const message =
            result.error?.code === 'workspace_closed'
              ? t('workspaceClosedReadOnly', { workspace: t('workspace') })
              : reason === 'not_assignee'
                ? t('todayMarkNotAssignee', { assignee: t('assignee') })
                : reason === 'completed'
                  ? t('todayMarkDone', { task: t('task'), done: t('done') })
                  : result.status === 404 && !inBacklog
                    ? t('todayMarkBacklogOnly', { inbox: t('inbox'), archive: t('archive') })
                    : t('todayMarkFailed');
          showToast(message, 'alert');
        }
        if (result.status === 401) onstale();
      }
    } finally {
      marking = false;
    }
  }

  // 期日の印を決める、ワークスペースの今日と週の始まり（task-detail の値。ブラウザの時計に頼らない）
  let clock = $state<{ today: string; weekStart: number } | null>(null);
  // 削除していない決まった欄と値（task-detail の fields。書かれていなければ value_md が null）
  let fields = $state<TaskFieldValue[]>([]);
  // バックログのタスクか。受信箱とアーカイブのタスクには、欄ごとの「未記入」の印を出さない（木の行と件数と同じ範囲）
  let inBacklog = $state(false);
  const todayDisabledReason = $derived(
    !canWrite
      ? t('workspaceClosedReadOnly', { workspace: t('workspace') })
      : !inBacklog
        ? t('todayMarkBacklogOnly', { inbox: t('inbox'), archive: t('archive') })
        : task?.completed_at != null
          ? t('todayMarkCompleted', { done: t('done'), task: t('task') })
          : currentUserId === null || task?.assignee?.id !== currentUserId
            ? t('todayMarkOwnOnly', { task: t('task') })
            : null,
  );
  let heading = $state<HTMLElement>();
  let retryButton = $state<HTMLButtonElement>();
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();

  // 直している途中の欄ごとの書きかけ（保存の要求を送っている間も数える）
  const dirty = $state({ title: false, link: false, body: false, fields: false });
  // 書きかけ。タイトル、リンク、本文、決まった欄の書きかけと、まだ送っていない期日の入力（待っている間と、打ちかけ）と担当の選択（待っている間）と、
  // コメントの書きかけ（新しいコメントの欄の文字と、直している途中のコメント。TaskComments の hasDraft）
  function hasDraft(): boolean {
    return (
      dirty.title ||
      dirty.link ||
      dirty.body ||
      dirty.fields ||
      dueUnsent() ||
      assigneeChoice !== null ||
      categoryChoice !== null ||
      (commentsPanel?.hasDraft() ?? false)
    );
  }

  // ---- コメントと変更の履歴のタブ ----
  let tab = $state<'comments' | 'history'>('comments');
  // 消していないコメントの数（タブの「コメント N」）。読む前は null で、数を出さない
  let commentCount = $state<number | null>(null);
  let commentsPanel = $state<ReturnType<typeof TaskComments>>();
  const tabOrder = ['comments', 'history'] as const;

  function selectTab(next: (typeof tabOrder)[number]): void {
    tab = next;
  }

  // 左右の矢印キーと Home、End で、隣のタブを選んでフォーカスを移す（WAI-ARIA のタブの決まり）
  async function onTabKeydown(event: KeyboardEvent): Promise<void> {
    const at = tabOrder.indexOf(tab);
    const target =
      event.key === 'ArrowRight'
        ? tabOrder[(at + 1) % tabOrder.length]
        : event.key === 'ArrowLeft'
          ? tabOrder[(at - 1 + tabOrder.length) % tabOrder.length]
          : event.key === 'Home'
            ? tabOrder[0]
            : event.key === 'End'
              ? tabOrder[tabOrder.length - 1]
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    tab = target;
    await tick();
    document.getElementById(target === 'comments' ? commentsTabId : historyTabId)?.focus();
  }

  // 選んだポイント。送っている間（と、続けて選んだ分を送り終えるまで）は、最後に選んだ値を見せる
  let pointsPending = $state<{ value: PointsChoice } | null>(null);
  const pointsShown = $derived<PointsChoice>(pointsPending !== null ? pointsPending.value : (task?.points ?? null));
  let pointsError = $state<string | null>(null);
  let pointsSending = false;
  let dueError = $state<string | null>(null);
  let dueInput = $state<HTMLInputElement>();
  let dueTimer: ReturnType<typeof setTimeout> | undefined;
  let dueSending = false;
  let dueAgain = false;
  // 期日の入力欄が、保存した値と同じ（同期済み）か、最後に送った値のときの文字。入力がこれと違えば、まだ送っていない入力がある
  let dueBase = '';
  let dueBoundTo: HTMLInputElement | undefined;
  // タスクが消えていた。保存の続きを送らない
  let taskGone = false;
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);
  let loadVersion = 0;

  // 部品が外れた後の応答で、状態を触らない
  let alive = true;
  $effect(() => () => {
    alive = false;
    clearTimeout(dueTimer);
    clearTimeout(assigneeTimer);
    clearTimeout(categoryTimer);
  });

  // 捨てると決めた後、閉じる／移るために確認を飛ばす
  let leaving = false;
  let asking = false;

  // 担当の候補（そのワークスペースに今所属している人）。読み込む前と読めなかったときは null
  let candidates = $state<readonly { id: string; name: string }[] | null>(null);
  let candidatesFailed = $state(false);
  let candidatesVersion = 0;
  let candidatesLoading = $state(false);
  // 選択欄で選んで、まだ送っていない担当（待っている間）。閉じた選択欄で矢印キーを押すと、1つ動くたびに change が出るので、
  // 期日と同じく少し待ってから（か欄を離れたときに）最後の値だけを送る
  let assigneeChoice = $state<{ value: string } | null>(null);
  let assigneeTimer: ReturnType<typeof setTimeout> | undefined;
  let assigneeSelect = $state<HTMLSelectElement>();
  // 送っている担当（空は担当なし）。送っている間（と、続けて選んだ分を送り終えるまで）は、最後に選んだ値を見せる
  let assigneePending = $state<{ value: string } | null>(null);
  let assigneeError = $state<string | null>(null);
  let assigneeSending = false;

  // 区分とリポジトリの選択肢（直せるときだけ読む）。読む前と読めなかったときは null
  let definitions = $state<{ categories: DefinitionRef[]; repositories: DefinitionRef[] } | null>(null);
  let definitionsLoading = $state(false);
  let definitionsFailed = $state(false);
  let definitionsVersion = 0;
  // 送っているリポジトリ（null はなし）。送っている間（と、続けて選んだ分を送り終えるまで）は、最後に選んだ値を見せる
  let repositoryPending = $state<{ value: string | null } | null>(null);
  let repositoryError = $state<string | null>(null);
  let repositorySending = false;
  const repositoryShown = $derived(
    repositoryPending !== null ? repositoryPending.value : (task?.repository?.id ?? null),
  );
  // 選択欄で選んで、まだ送っていない区分（待っている間）と、送っている区分。空は区分なし
  let categoryChoice = $state<{ value: string } | null>(null);
  let categoryTimer: ReturnType<typeof setTimeout> | undefined;
  let categoryPending = $state<{ value: string } | null>(null);
  let categoryError = $state<string | null>(null);
  let categorySending = false;
  let categorySelect = $state<HTMLSelectElement>();
  // 自身に振った区分（親から引き継いだものは除く）
  const ownCategory = $derived(task?.category != null && !task.category.inherited ? task.category : null);
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
    // 選択欄が外れると（閉じた、親の下へ移された）bind:this が null になるので、null も外す
    if (select != null && select.value !== value) select.value = value;
  });
  const categoryEditable = $derived(canWrite && task !== null && task.story_id === null);

  const pointsEditable = $derived(canWrite && task !== null && task.completed_at === null);
  const assigneeEditable = $derived(canWrite && task !== null && task.completed_at === null);
  const assigneeShownId = $derived(
    assigneeChoice !== null
      ? assigneeChoice.value
      : assigneePending !== null
        ? assigneePending.value
        : (task?.assignee?.id ?? ''),
  );
  // 選択欄の選択肢。候補に、今の担当が候補にいなければ（抜けた、候補を読めなかった）その人を足す
  const assigneeOptions = $derived.by(() => {
    const options: { id: string; name: string; left: boolean }[] = (candidates ?? []).map((candidate) => ({
      ...candidate,
      left: false,
    }));
    const current = task?.assignee ?? null;
    if (current !== null && !options.some((option) => option.id === current.id)) options.unshift(current);
    return options;
  });
  // アバターに出す人。選んだ候補か今の担当
  const assigneeShown = $derived(assigneeOptions.find((option) => option.id === assigneeShownId) ?? null);
  // 選択欄の値を、見せる値に合わせる。保存に失敗して前の値へ戻すときと、候補を読み直して選択肢が替わったときも合わせる。
  // 引き出しの中で完了にすると選択欄が外れ、bind:this が null になるので、null も外す
  $effect(() => {
    const select = assigneeSelect;
    const value = assigneeShownId;
    void assigneeOptions;
    if (select != null && select.value !== value) select.value = value;
  });
  const titleEditable = $derived(canWrite && task !== null && !task.is_imported);
  const done = $derived(task?.completed_at != null);

  // ---- 変更の履歴（task-history） ----
  let historyState = $state<'loading' | 'ready' | 'failed'>('loading');
  let historyEntries = $state.raw<readonly TaskHistoryEntry[]>([]);
  let historyNext = $state<{ created_at: string; id: string } | null>(null);
  let historyTimezone = $state('UTC');
  // 「さらに読む」の状態
  let historyMore = $state<'idle' | 'loading' | 'failed'>('idle');
  // 先頭を読み直している間（「さらに読む」を止め、「もう一度試す」を押せなくする）
  let historyReloading = $state(false);
  // 行を出した後の読み直し（保存した後）に失敗した。行は残し、節の上に失敗と「もう一度試す」を添える
  let historyReloadFailed = $state(false);
  let historyVersion = 0;
  // 「変更の履歴」のタブの中身（tabpanel）。読み直せたときと読み終えたときに、フォーカスを置く
  let historyPanel = $state<HTMLElement>();
  // 「さらに読む」で足したことの知らせ。節の中に常に置いた role="status" の領域に入れる
  let historyAdded = $state('');
  // 履歴の読み込みの進み具合を読み上げに伝える（見える「読み込んでいます」は aria-hidden にする）
  const historyStatus = $derived(historyState === 'loading' || historyMore === 'loading' ? t('loading') : historyAdded);
  // 履歴の行の文は、列の名前と操作の言葉を辞書の t で組む（t を $derived の中で呼ぶ）
  const historyViews = $derived(historyEntries.map((entry) => historyEntryView(entry, historyTimezone, t)));

  // 先頭の 50 件を読み直す。読み直している間は、前に読めた行を残す（保存のたびに消えてちらつかない）。
  // 失敗したら、行がまだ無ければ節を失敗の表示に、行があれば行を残して失敗を添える。
  // focusAfter は「もう一度試す」から読んだとき。読めたらボタンが消えるので、タブの中身へフォーカスを移す
  async function loadHistory(focusAfter = false): Promise<void> {
    const mine = ++historyVersion;
    historyReloading = true;
    historyMore = 'idle';
    const result = await callOperation(taskHistory, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!alive || mine !== historyVersion) return;
    historyReloading = false;
    if (result.ok) {
      historyEntries = result.data.entries;
      historyNext = result.data.next;
      historyTimezone = result.data.timezone;
      historyState = 'ready';
      historyReloadFailed = false;
      if (focusAfter) {
        await tick();
        if (alive) historyPanel?.focus();
      }
      return;
    }
    // 404 はタスクが消えた（別の人が削除した）。もう一度試しても読めないので、閉じる側へ回す
    if (result.status === 404) {
      if (!taskGone) gone();
      return;
    }
    if (historyState === 'ready') historyReloadFailed = true;
    else historyState = 'failed';
  }

  function retryHistory(): void {
    if (historyReloading) return;
    void loadHistory(true);
  }

  // 続きの 50 件を足す。先頭を読み直している間は押しても何もしない。先頭を読み直したら、古い続きの応答は捨てる
  async function loadMoreHistory(): Promise<'added' | 'dropped' | 'failed'> {
    const before = historyNext;
    if (before === null || historyMore === 'loading' || historyReloading) return 'dropped';
    const mine = historyVersion;
    historyMore = 'loading';
    historyAdded = '';
    const result = await callOperation(taskHistory, { workspace_id: workspaceId, task_id: taskId, before }, { slug });
    if (!alive || mine !== historyVersion) return 'dropped';
    if (result.ok) {
      historyEntries = [...historyEntries, ...result.data.entries];
      historyNext = result.data.next;
      historyMore = 'idle';
      historyAdded = t('historyMoreAdded', { count: result.data.entries.length });
      return 'added';
    }
    historyMore = 'failed';
    return 'failed';
  }

  // 「さらに読む」。読み足して続きが無くなると押したボタンが消えるので、フォーカスをタブの中身へ移す
  async function showMoreHistory(): Promise<void> {
    const outcome = await loadMoreHistory();
    if (!alive || outcome !== 'added' || historyNext !== null) return;
    await tick();
    historyPanel?.focus();
  }

  // 前後のボタンで移ってきたときの、押した向き。置き直した引き出しは、読み込み中から同じ向きのボタンにフォーカスを持ち（Drawer の initialFocus）、
  // 最初の読み込みの終わりにも同じ向きのボタンへ置き、移った先のタイトルを読み上げる
  const arrivedByStep = consumeStepFocus();
  let stepFocus = arrivedByStep;
  // 移った先のタイトルの読み上げ。ボタンで移ったときだけ入れる（キーで移ったときは、見出しへのフォーカスで読まれる）。
  // 状態の読み上げ（status）とは別の領域にして、あとから状態が替わっても読み直されないようにする
  let movedStatus = $state('');

  async function load(): Promise<void> {
    const wantedStepFocus = stepFocus;
    stepFocus = null;
    const mine = ++loadVersion;
    loadState = 'loading';
    const result = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!alive || mine !== loadVersion) return;
    if (result.ok) {
      task = result.data.task;
      taskContext = {
        column: result.data.column,
        story: result.data.story,
        epic: result.data.epic,
        today_on: result.data.today_on,
      };
      fields = result.data.fields;
      inBacklog = result.data.in_backlog;
      clock = { today: result.data.today, weekStart: result.data.week_start };
      loadState = 'ready';
      void loadHistory();
      // 担当を選べるときだけ、候補を読む（読み取り専用では選択欄を出さない）
      if (canWrite && result.data.task.completed_at === null && candidates === null) void loadCandidates();
      // リポジトリと区分を直せるときだけ、選択肢を読む
      if (canWrite && definitions === null) void loadDefinitions();
      // 開いたときの読み上げに、見出しが読まれるようにする。閉じるボタンか何も無い所にフォーカスがあるときだけ移す
      await tick();
      if (!alive) return;
      // ボタンで移ってきたなら、移った先のタイトルを読み上げに出し、押したのと同じ向きのボタンへフォーカスを置く（続けて押せる）。
      // 押せない（端）なら見出しへ。読み込みの間に利用者が別の所へ移したフォーカスは奪わない
      const active = document.activeElement;
      const idle = active === document.body || active?.classList.contains('drawer-close');
      if (wantedStepFocus !== null) {
        movedStatus = t('drawerMoved', { task: t('task'), title: result.data.task.title });
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
    // 400 は、URL の `?task=` が ID の形でないとき。見つからないのと同じに扱う
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

  // タスクが消えていた（別の人が削除した）。閉じて、木を読み直す
  function gone(): void {
    leaving = true;
    taskGone = true;
    showToast(t('taskGone', { task: t('task') }), 'alert');
    onremoved(null, 'gone');
  }

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
    // 新しいタブを開けなかったときは移らず、今の詳細を残す
    if (!onmode(next)) leaving = false;
  }

  // 前後のタスクへ移る操作（帯のボタンと `[` `]`）。書きかけがあれば、閉じるときと同じ確認を挟む。
  // 移ると引き出しは置き直される（呼び出し側の {#key}）ので、移れなかったとき（移動が取り消された）だけ、この引き出しを続けられる状態に戻す
  // 移る先は確認の後に決め直す（確認の間に、順が替わったり、引き出しが閉じたりしうる）。消えていれば移らない。
  // ボタンで移ったときだけ、移った先の引き出しが、押したのと同じ向きのボタンへフォーカスを戻す（stepFocus。キーで移ったときは見出し）
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

  // 別のタスクや別の画面へ移るとき（戻る／進む、行のリンク、左のメニュー）も、書きかけがあれば確かめる。
  // 同じタスクのままの移動と、閉じると決めた後は通す。ページを離れる（タブを閉じる、外のサイト）ときは、cancel() がブラウザの確認を出す。
  // 捨てると決めた後、戻る／進むは履歴をその分だけ動かす（goto は履歴を積んでしまう）
  beforeNavigate((navigation) => {
    if (leaving || !hasDraft()) return;
    if (navigation.to === null) {
      navigation.cancel();
      return;
    }
    const to = navigation.to.url;
    if (to.origin === location.origin && to.pathname === location.pathname && to.searchParams.get('task') === taskId) {
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

  // 保存に使う応答の扱い。送った欄だけを応答で入れ替える（別の欄の保存と前後しても、古い値で戻さない）。
  // リポジトリと区分は ID で送り、応答の repository と category で入れ替える
  type Fields = Partial<Pick<TaskDetail, 'title' | 'points' | 'due_on' | 'link_url' | 'body_md'>> & {
    repository_id?: string | null;
    category_id?: string | null;
  };

  // 欄を書く。成功なら null、失敗ならエラーの文。404 は閉じる側へ回す（文は返さず、taskGone を立てる）。
  // 引き出しが閉じた後に返った応答（欄を離れた直後に × を押した、ポイントを選んだ直後に閉じた）も、黙って捨てない:
  // 通ったら木を読み直してトーストで知らせ、失敗はトーストで知らせる（画面の状態は触らない）
  // expected は自動保存の欄（タイトル、リンク、本文）が、書き始めた時点の値を添える。先にほかの人が同じ欄を直していたら、サーバーが断る。
  // 自動保存の欄は、保存の状態を欄の横に出すので、画面が残っている間はトーストを出さない
  async function saveFields(fields: Fields, attachmentIds: string[] = [], expected?: Expected): Promise<string | null> {
    const result = await callOperation(
      taskUpdate,
      {
        workspace_id: workspaceId,
        task_id: taskId,
        ...fields,
        attachment_ids: attachmentIds,
        ...(expected === undefined ? {} : { expected }),
      },
      { slug },
    );
    if (result.ok) {
      savedVersion++;
      if (alive && task !== null) {
        const saved = result.data.task;
        // この保存で書いた欄だけを反映する。応答を待つ間の完了・取り消しを古い値で戻さない。
        const merged: TaskDetail = { ...task };
        for (const key of Object.keys(fields) as (keyof Fields)[]) {
          if (key === 'repository_id') merged.repository = saved.repository;
          else if (key === 'category_id') merged.category = saved.category;
          else Object.assign(merged, { [key]: saved[key] });
        }
        task = merged;
        void loadHistory();
      }
      // 続けて書くときの読んだ値は、今保存した値にする
      if (expected !== undefined) {
        if ('title' in fields) bases.title = fields.title;
        if ('link_url' in fields) bases.link_url = fields.link_url ?? '';
        if ('body_md' in fields) bases.body_md = fields.body_md ?? '';
      }
      if (expected === undefined || !alive) showToast(t('taskSaved'), 'check');
      onchanged();
      return null;
    }
    const attachmentError = attachmentSaveFailure(result.status, result.error, attachmentIds);
    if (attachmentError !== null) return attachmentError;
    // 選んだリポジトリか区分が削除されていた（タスクはある）。一覧を読み直して、選び直してもらう
    if (result.status === 404 && (fields.repository_id != null || fields.category_id != null) && (await refresh())) {
      if (alive) void loadDefinitions();
      const message = t('definitionRefGone', {
        kind: fields.repository_id != null ? t('repository') : t('category'),
      });
      if (!alive) showToast(message, 'alert');
      return message;
    }
    if (result.status === 404) {
      taskGone = true;
      if (alive) gone();
      else {
        showToast(t('taskGone', { task: t('task') }), 'alert');
        onchanged();
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
      message = await conflictMessage(fields, result.error?.details);
    } else {
      message = result.status === 400 ? t('taskBadRequest') : t('taskSaveFailed');
    }
    // 自動保存の欄（expected を添える）は、閉じた後の失敗を AutoSaveEdit がトーストで知らせる
    if (!alive && expected === undefined) showToast(message, 'alert');
    return message;
  }

  // 409 の文。断った理由は、読み直した今の値で決める（完了していればポイントが理由、取り込んだタスクならタイトルとリンクが理由、
  // どちらでもなければ、同じ欄を同時に直された）。読み直した値は、引き出しが開いていれば表示にも入れる
  async function conflictMessage(fields: Fields, details?: unknown): Promise<string> {
    const latest = await refresh();
    const current = latest ?? task;
    // 書き始めてからほかの人が先に同じ欄を直していた。書いた分は欄に残し、今の値を並べて知らせる。次の保存は、今の値を読んだものとして送る
    const stale = staleCurrentOf(details);
    // 引き出しが閉じた後は、書いた分を残す欄が無い。残してあるとは言わない
    if (stale !== null && !alive) return t('taskSaveRaced');
    if (stale !== null) {
      const key = (['title', 'link_url', 'body_md'] as const).find((name) => name in stale);
      if (key !== undefined) {
        const now = stale[key];
        bases[key] = typeof now === 'string' ? now : '';
        return t('taskFieldStale', { current: excerpt(typeof now === 'string' ? now : '') });
      }
    }
    if ('points' in fields && current?.completed_at != null) {
      return t('taskSaveConflict', { task: t('task'), done: t('done'), points: t('points') });
    }
    if (current?.is_imported && ('title' in fields || 'link_url' in fields)) {
      return t('taskImportedLocked', { task: t('task') });
    }
    if ('category_id' in fields && current?.story_id != null) {
      return t('categoryHasParent', { task: t('task'), category: t('category') });
    }
    return t('taskSaveRaced');
  }

  // 今の値を読み直す。読めなければ今の表示のまま（null）
  function refresh(closeIfGone = false): Promise<TaskDetail | null> {
    const requestedVersion = ++refreshVersion;
    const requestedSavedVersion = savedVersion;
    const requestedTaskId = taskId;
    // このタスクで削除判定を求めた読み取りは、後発へ譲っても失わない。
    refreshCloseIfGone = closeIfGone || (latestRefreshTaskId === requestedTaskId && refreshCloseIfGone);
    latestRefreshTaskId = requestedTaskId;
    const pending = (async (): Promise<TaskDetail | null> => {
      const result = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: requestedTaskId }, { slug });
      // 閉じた後も同じタスクの読めた結果は返す。保存元が成功を失敗や削除と誤認しないため。
      if (!alive) return result.ok ? result.data.task : null;
      if (taskId !== requestedTaskId) return null;
      // 後発の読み取りに表示を譲る場合も、その結果を呼び出し元へ返す。null は読み取り失敗だけを表す。
      if (requestedVersion !== refreshVersion) return latestRefreshTaskId === requestedTaskId ? latestRefresh : null;
      if (!result.ok) {
        if (refreshCloseIfGone && result.status === 404 && alive) gone();
        return null;
      }
      if (alive && taskId === requestedTaskId) {
        // 途中で保存が通ったら、その後の値を取り直す。古い欄を戻さず、完了状態や権限も取りこぼさない。
        if (requestedSavedVersion !== savedVersion) return refresh(refreshCloseIfGone);
        task = result.data.task;
        fields = result.data.fields;
        taskContext = {
          column: result.data.column,
          story: result.data.story,
          epic: result.data.epic,
          today_on: result.data.today_on,
        };
        inBacklog = result.data.in_backlog;
        clock = { today: result.data.today, weekStart: result.data.week_start };
        if (canWrite && task?.completed_at === null && candidates === null) void loadCandidates();
        void loadHistory();
      }
      return result.data.task;
    })();
    latestRefresh = pending;
    return pending;
  }

  // ---- 決まった欄（TaskFieldValues が task-field-set で保存する） ----
  // 書けた。応答の欄だけを入れ替え（別の欄の保存と前後しても、古い値で戻さない）、履歴と木を読み直す
  function fieldSaved(saved: TaskFieldValue): void {
    savedVersion++;
    if (!alive) {
      onchanged();
      return;
    }
    fields = fields.map((field) => (field.id === saved.id ? saved : field));
    void loadHistory();
    onchanged();
  }

  // 欄かタスクが見つからなかった。読み直して、タスクが消えていれば閉じる。欄だけが削除されていたら、欄の一覧から外れ、入力欄ごと
  // 書きかけが消えるので、トーストで知らせる（理由の文が入力欄と一緒に消えるため）。読み直せなかったときは削除されたと言い切らず、
  // false を返す（呼んだ側がふつうの失敗の文を出す）。欄が一覧から外れたことを確かめられたら true
  async function fieldMissing(fieldId: string): Promise<boolean> {
    const latest = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!latest.ok && latest.status === 404) {
      taskGone = true;
      if (alive) gone();
      else {
        showToast(t('taskGone', { task: t('task') }), 'alert');
        onchanged();
      }
      return false;
    }
    if (!latest.ok) return false;
    if (alive) {
      task = latest.data.task;
      taskContext = {
        column: latest.data.column,
        story: latest.data.story,
        epic: latest.data.epic,
        today_on: latest.data.today_on,
      };
      fields = latest.data.fields;
      inBacklog = latest.data.in_backlog;
    }
    const removed = !latest.data.fields.some((field) => field.id === fieldId);
    if (removed) showToast(t('fieldValueGone'), 'alert');
    return removed;
  }

  // ---- 担当（選んで少し待ってから、か欄を離れたときに保存する。1本ずつ送る） ----
  // 候補を読む。読めなければ、担当なしと今の担当だけを選べるままにし、読めなかったことと「もう一度試す」を添える
  async function loadCandidates(): Promise<void> {
    const mine = ++candidatesVersion;
    candidatesLoading = true;
    const result = await callOperation(memberList, { workspace_id: workspaceId }, { slug });
    if (!alive || mine !== candidatesVersion) return;
    candidatesLoading = false;
    if (result.ok) {
      candidates = result.data.members.map((member) => ({ id: member.id, name: member.name }));
      candidatesFailed = false;
    } else {
      candidatesFailed = true;
    }
  }

  // 候補を読み直す。読めたら、押したボタンは消えるので、担当の選択欄へフォーカスを移す
  async function retryCandidates(): Promise<void> {
    if (candidatesLoading) return;
    await loadCandidates();
    if (!alive || candidatesFailed) return;
    await tick();
    assigneeSelect?.focus();
  }

  function onAssigneeChange(event: Event & { currentTarget: HTMLSelectElement }): void {
    assigneeChoice = { value: event.currentTarget.value };
    scheduleAssignee();
  }

  // 待ってから送る。捨てるかの確認を出している間は送らず、待ちを延ばす（期日と同じ）
  function scheduleAssignee(): void {
    clearTimeout(assigneeTimer);
    assigneeTimer = setTimeout(() => {
      if (asking) scheduleAssignee();
      else if (!leaving) commitAssignee();
    }, DUE_DEBOUNCE_MS);
  }

  function onAssigneeBlur(): void {
    // 捨てるかの確認にフォーカスが移ったときと、捨てると決めて部品が外れるときは、送らない（期日と同じ）
    if (asking || leaving) return;
    commitAssignee();
  }

  // 待っている選択を、送る列へ渡す
  function commitAssignee(): void {
    clearTimeout(assigneeTimer);
    const choice = assigneeChoice;
    if (choice === null) return;
    assigneeChoice = null;
    chooseAssignee(choice.value);
  }

  function chooseAssignee(value: string): void {
    // 送っている間に選び直されたら、最後の選択だけを残す
    assigneePending = { value };
    if (!assigneeSending) void sendAssignee();
  }

  // ポイントと同じく、引き出しが閉じた後も溜めた最後の選択まで送る。タスクが消えたか、完了にされていたら、溜めた分を捨てる
  async function sendAssignee(): Promise<void> {
    assigneeSending = true;
    try {
      while (assigneePending !== null && !taskGone) {
        const choice = assigneePending.value;
        if (task === null || choice === (task.assignee?.id ?? '') || task.completed_at !== null) {
          assigneePending = null;
          break;
        }
        assigneeError = null;
        const message = await saveAssignee(choice === '' ? null : choice);
        if (message !== null) {
          assigneeError = message;
          if (assigneePending === null || assigneePending.value === choice) assigneePending = null;
          continue;
        }
        if (assigneePending !== null && assigneePending.value === choice) assigneePending = null;
      }
      if (taskGone) assigneePending = null;
    } finally {
      assigneeSending = false;
    }
  }

  // 担当を書く。成功なら null、失敗ならエラーの文（saveFields と同じ扱い）。404 は、タスクが消えたか、選んだ人が所属を外れたかを、
  // 読み直して分ける（タスクがあれば、候補を読み直して、選び直しを促す）
  async function saveAssignee(assigneeUserId: string | null): Promise<string | null> {
    const result = await callOperation(
      taskAssign,
      { workspace_id: workspaceId, task_id: taskId, assignee_user_id: assigneeUserId },
      { slug },
    );
    if (result.ok) {
      savedVersion++;
      if (alive && task !== null) {
        const saved = result.data.task;
        if (saved.assignee?.id !== task.assignee?.id) {
          assigneeVersion++;
          taskContext = { ...taskContext, today_on: null };
        }
        task = {
          ...task,
          assignee: saved.assignee,
          completed_at: saved.completed_at,
          can_delete: saved.can_delete,
          can_send_thanks: saved.can_send_thanks,
        };
        await refresh();
      }
      showToast(t('taskSaved'), 'check');
      onchanged();
      return null;
    }
    let message: string;
    if (result.status === 404) {
      const latest = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
      if (!latest.ok && latest.status === 404) {
        taskGone = true;
        if (alive) gone();
        else {
          showToast(t('taskGone', { task: t('task') }), 'alert');
          onchanged();
        }
        return null;
      }
      if (!latest.ok) {
        // 読み直せなかった（通信、5xx など）。どちらが理由か分からないので、ふつうの失敗の文にする
        message = t('taskSaveFailed');
      } else {
        if (alive) {
          task = latest.data.task;
          taskContext = {
            column: latest.data.column,
            story: latest.data.story,
            epic: latest.data.epic,
            today_on: latest.data.today_on,
          };
          clock = { today: latest.data.today, weekStart: latest.data.week_start };
          void loadCandidates();
        }
        message = t('assigneeNotMember', { workspace: t('workspace'), assignee: t('assignee') });
      }
    } else if (result.status === 401) {
      onstale();
      message = t('taskSaveFailed');
    } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
      onstale();
      message = t('workspaceClosedReadOnly', { workspace: t('workspace') });
    } else if (result.status === 409) {
      // 完了にされていれば、それが理由。そうでなければ、同時に担当を替えられた
      const latest = await refresh();
      message =
        (latest ?? task)?.completed_at != null
          ? t('taskAssigneeDone', { task: t('task'), done: t('done'), assignee: t('assignee') })
          : t('taskSaveRaced');
    } else {
      message = result.status === 400 ? t('taskBadRequest') : t('taskSaveFailed');
    }
    if (!alive) showToast(message, 'alert');
    return message;
  }

  // ---- タイトル、リンク、本文（AutoSaveEdit） ----
  // 描いた本文を押したら書く欄に替える。本文の中のリンクと、文字を選ぶ操作は、そのまま通す
  function beginFromSurface(event: MouseEvent, begin: (event: Event) => void): void {
    if (event.target instanceof Element && event.target.closest('a, button, summary, input')) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    begin(event);
  }

  function titleProblem(raw: string): string | null {
    const problem = taskTitleProblem(raw.trim());
    if (problem === 'required') return t('taskTitleRequired');
    if (problem === 'too_long') return t('taskTitleTooLong', { max: TASK_TITLE_MAX_LENGTH });
    if (problem === 'invalid_character') return t('taskTitleInvalidCharacter');
    return null;
  }

  // 書き始めた時点の値（保存の expected）。直している間に読み直しで別の人の値が入っても、黙って上書きしない。
  // 断られて読み直した後は、今の値に置き換える（読み直した内容を知らせた上で、続けて書くと上書きする）
  // 空は空の文字（expected は入力の形）。書き始めていなければ undefined で、そのときは保存の時点の値を使う
  const bases: { title?: string; link_url?: string; body_md?: string } = {};
  type Expected = { title?: string; link_url?: string; body_md?: string };

  // 409 の stale の details から、今の値の組を取り出す
  function staleCurrentOf(details: unknown): Record<string, unknown> | null {
    if (typeof details !== 'object' || details === null) return null;
    const record = details as { reason?: unknown; current?: unknown };
    if (record.reason !== 'stale' || typeof record.current !== 'object' || record.current === null) return null;
    return record.current as Record<string, unknown>;
  }

  // 知らせに添える今の値は、長いと欄を押し出すので短くする
  function excerpt(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat === '' ? t('bodyEmpty') : flat;
  }

  function saveTitle(raw: string): Promise<string | null> {
    const next = raw.trim();
    return task === null || next === task.title
      ? Promise.resolve(null)
      : saveFields({ title: next }, [], { title: bases.title ?? task.title });
  }

  function beginTitle(started: string): void {
    bases.title = started;
  }

  function beginLink(started: string): void {
    bases.link_url = started;
  }

  function beginBody(started: string): void {
    bases.body_md = started;
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
    return task === null || linkForm(raw) === (task.link_url ?? '')
      ? Promise.resolve(null)
      : saveFields({ link_url: value }, [], { link_url: bases.link_url ?? task.link_url ?? '' });
  }

  function bodyProblem(raw: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field: t('fieldBody'), max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field: t('fieldBody') });
    return null;
  }

  function saveBody(raw: string, attachmentIds: string[] = []): Promise<string | null> {
    const next = normalizeLongText(raw);
    return task === null || (next === task.body_md && attachmentIds.length === 0)
      ? Promise.resolve(null)
      : saveFields({ body_md: next }, attachmentIds, { body_md: bases.body_md ?? task.body_md ?? '' });
  }

  // ---- ポイント（選んだら保存する。1本ずつ送る） ----
  function choosePoints(choice: PointsChoice): void {
    // 送っている間に選び直されたら、最後の選択だけを残す
    pointsPending = { value: choice };
    if (!pointsSending) void sendPoints();
  }

  // 引き出しが閉じた後も、溜めた最後の選択まで送る（選んだ値を黙って失わない）。送った結果の通知は saveFields がする。
  // 先の要求が失敗しても、送っている間に選び直された最後の選択は捨てずに送る（次の送信を始めるときに、前の失敗の文は消す）。
  // タスクが消えた（404）か、完了にされていた（ポイントを直せない）ときは、同じ要求を繰り返さず、溜めた分を捨てる
  async function sendPoints(): Promise<void> {
    pointsSending = true;
    try {
      while (pointsPending !== null && !taskGone) {
        const choice = pointsPending.value;
        // 保存した値（最後に送って通った値）と同じなら送らない
        if (task === null || choice === task.points || task.completed_at !== null) {
          pointsPending = null;
          break;
        }
        pointsError = null;
        const message = await saveFields({ points: choice });
        if (message !== null) {
          pointsError = message;
          // 選び直されていなければ、ここで終わる。選び直されていれば、次の周で最後の選択を送る
          if (pointsPending === null || pointsPending.value === choice) pointsPending = null;
          continue;
        }
        if (pointsPending !== null && pointsPending.value === choice) pointsPending = null;
      }
      if (taskGone) pointsPending = null;
    } finally {
      pointsSending = false;
    }
  }

  // ---- リポジトリと区分 ----
  // 選択肢は、直せるときだけ category-repository-list で読む。読めなければ、なしと今の値だけを選べる
  // 読めなければ、担当の候補と同じく、読めなかったことと「もう一度試す」を添える
  async function loadDefinitions(): Promise<void> {
    const mine = ++definitionsVersion;
    definitionsLoading = true;
    const result = await callOperation(categoryRepositoryList, { workspace_id: workspaceId }, { slug });
    if (!alive || mine !== definitionsVersion) return;
    definitionsLoading = false;
    if (result.ok) {
      definitions = result.data;
      definitionsFailed = false;
    } else {
      definitionsFailed = true;
    }
  }

  // 読み直す。読めたら、押したボタンは消えるので、リポジトリの今の選択へフォーカスを移す
  async function retryDefinitions(): Promise<void> {
    if (definitionsLoading) return;
    await loadDefinitions();
    if (!alive || definitionsFailed) return;
    await tick();
    document.querySelector<HTMLInputElement>(`[aria-labelledby="${repositoryLabelId}"] input:checked`)?.focus();
  }

  // リポジトリは、選んだら保存する（ポイントと同じく1本ずつ送り、送っている間に選び直した分は最後の選択だけを送る）
  function chooseRepository(value: string | null): void {
    repositoryPending = { value };
    if (!repositorySending) void sendRepository();
  }

  async function sendRepository(): Promise<void> {
    repositorySending = true;
    try {
      while (repositoryPending !== null && !taskGone) {
        const choice = repositoryPending.value;
        if (task === null || choice === (task.repository?.id ?? null)) {
          repositoryPending = null;
          break;
        }
        repositoryError = null;
        const message = await saveFields({ repository_id: choice });
        if (message !== null) {
          repositoryError = message;
          if (repositoryPending === null || repositoryPending.value === choice) repositoryPending = null;
          continue;
        }
        if (repositoryPending !== null && repositoryPending.value === choice) repositoryPending = null;
      }
      if (taskGone) repositoryPending = null;
    } finally {
      repositorySending = false;
    }
  }

  // 区分は、担当と同じく、選んで少し待ってから（閉じた選択欄の矢印キーは1つ動くたびに change を出すため）か、欄を離れたときに、
  // 最後の値だけを保存する。親のあるタスクには出さない（親から引き継ぐ）
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

  async function sendCategory(): Promise<void> {
    categorySending = true;
    try {
      while (categoryPending !== null && !taskGone) {
        const choice = categoryPending.value;
        const own = task?.category != null && !task.category.inherited ? task.category.id : '';
        if (task === null || choice === own || task.story_id !== null) {
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
      if (taskGone) categoryPending = null;
    } finally {
      categorySending = false;
    }
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
    void commitDue(true);
  }

  function onDueBlur(): void {
    // 捨てるかの確認のダイアログにフォーカスが移ったときと、捨てると決めて部品が外れるとき（Chrome は、フォーカスのある要素が
    // 外れると blur を出す）は、送らない（待っている入力は書きかけとして確かめた結果、捨てる）
    if (asking || leaving) return;
    clearTimeout(dueTimer);
    void commitDue(true);
  }

  // 入力欄の値は、保存した値に追従させる。ただし、入力が最後に同期した（か送った）値のままのときだけ。
  // 送っている間に次の値を選んだ（入力が違う）ときは、先の応答で上書きしない
  $effect(() => {
    const saved = task?.due_on ?? '';
    const input = dueInput;
    // 書き込めなくなって（終了が分かって）欄が外れると、bind:this は null になるので、null も外す
    if (input == null) return;
    if (input !== dueBoundTo) {
      dueBoundTo = input;
      dueBase = input.value;
    }
    if (input.value === dueBase) {
      input.value = saved;
      dueBase = saved;
    }
  });

  // まだ送っていない期日の入力がある（待っている間、打ちかけ、送っている間に選んだ次の値）
  function dueUnsent(): boolean {
    return dueInput != null && dueInput.value !== dueBase;
  }

  // final は、欄を離れたか Enter。書けない値のときだけ、ここで知らせる
  async function commitDue(final: boolean): Promise<void> {
    const input = dueInput;
    if (task === null || input == null || taskGone) return;
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
    if (next === task.due_on) {
      dueBase = value;
      return;
    }
    dueSending = true;
    dueBase = value;
    dueError = null;
    try {
      const message = await saveFields({ due_on: next });
      if (message !== null) {
        dueError = message;
        // 失敗したら、保存した値へ戻す。ただし、送っている間に打っている次の値は消さない
        if (alive && input.value === value) {
          input.value = task?.due_on ?? '';
          dueBase = input.value;
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
    dueInput.value = '';
    // 「クリア」は空にすると消えるので、フォーカスを期日の入力欄へ移す
    dueInput.focus();
    void commitDue(true);
  }

  // ---- 完了にする（確かめのダイアログは挟まない。1本だけ送る） ----
  let completing = $state(false);
  let doneMark = $state<HTMLElement>();

  async function complete(): Promise<void> {
    // 戻している間は完了にしない
    if (task === null || completing || reopening || task.completed_at !== null) return;
    completing = true;
    try {
      const result = await callOperation(taskComplete, { workspace_id: workspaceId, task_id: taskId }, { slug });
      if (!alive) {
        // 送っている間に閉じられた。通ったら木を読み直して知らせ、失敗は知らせる
        if (result.ok) {
          showToast(completedMessage(result.data.left_sprint, result.data.xp_granted, t), 'check');
          onchanged();
        } else if (result.status !== 409 || result.error?.code !== 'conflict') {
          showToast(t('taskCompleteFailed', { done: t('done') }), 'alert');
        }
        return;
      }
      if (result.ok) {
        if (task !== null) task = { ...task, completed_at: result.data.completed_at };
        showToast(completedMessage(result.data.left_sprint, result.data.xp_granted, t), 'check');
        // 戻せるか（reopenable）と、始まっていないスプリントから外れたことを出すため、詳細ごと読み直す（履歴も読み直す）
        await refresh();
        onchanged();
      } else if (result.status === 401) {
        onstale();
        return;
      } else if (result.status === 404) {
        gone();
        return;
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        onstale();
        return;
      } else if (result.status === 409) {
        // 別の画面で先に完了にされていた。読み直して、完了の印で示す
        showToast(t('taskAlreadyDone', { task: t('task'), done: t('done') }), 'check');
        await refresh();
        onchanged();
      } else {
        showToast(t('taskCompleteFailed', { done: t('done') }), 'alert');
        return;
      }
    } finally {
      if (alive) completing = false;
    }
    // 押したボタンは完了の印に替わって消えるので、フォーカスを印へ移す
    await tick();
    if (alive) doneMark?.focus();
  }

  // ---- 完了を戻す（確かめのダイアログは挟まない。1本だけ送る） ----
  let reopening = $state(false);
  let completeButton = $state<HTMLElement>();

  function reopenFailureMessage(details: unknown): string {
    const words = { task: t('task'), done: t('done'), sprint: t('sprint'), story: t('story') };
    switch (taskReopenConflictReasonOf(details)) {
      case 'not_completed':
        return t('taskReopenNotDone', words);
      case 'sprint_closed':
        return t('taskReopenSprintClosed', words);
      case 'parent_completed':
        return t('taskReopenParentDone', words);
      default:
        return t('taskReopenChanged');
    }
  }

  async function reopen(): Promise<void> {
    if (task === null || reopening || completing || task.completed_at === null) return;
    reopening = true;
    try {
      const result = await callOperation(taskReopen, { workspace_id: workspaceId, task_id: taskId }, { slug });
      if (!alive) {
        // 送っている間に閉じられた。通ったら木を読み直して知らせ、失敗は知らせる
        if (result.ok) {
          showToast(t('taskReopened', { task: t('task'), done: t('done') }), 'check');
          onchanged();
        } else if (result.status !== 401) {
          showToast(t('taskReopenFailed', { done: t('done') }), 'alert');
        }
        return;
      }
      if (result.ok) {
        if (task !== null) task = { ...task, completed_at: null, reopenable: false };
        showToast(t('taskReopened', { task: t('task'), done: t('done') }), 'check');
        await refresh();
        onchanged();
      } else if (result.status === 401) {
        onstale();
        return;
      } else if (result.status === 404) {
        gone();
        return;
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        onstale();
        return;
      } else if (result.status === 409) {
        // 別の画面で先に戻されたか、戻せない状態になっていた。読み直して、今の状態で示す
        showToast(reopenFailureMessage(result.error?.details), 'alert');
        await refresh();
        onchanged();
      } else {
        showToast(t('taskReopenFailed', { done: t('done') }), 'alert');
        return;
      }
    } finally {
      if (alive) reopening = false;
    }
    // 押した「戻す」は消えるので、「完了にする」か（戻せないまま完了していれば）印へフォーカスを移す
    await tick();
    if (alive) (task?.completed_at == null ? completeButton : doneMark)?.focus();
  }

  // ---- 削除 ----
  // 消したことを知らせるトースト（announceRemoved）と取り消し（restoreRemoved）は、行とカードの「⋯」と共有する（task-removal.ts）。
  // 引き出しが閉じた後でも押せるよう、props と ID は消した時点の値を取っておく（this の状態は読まない）
  // 削除を送る前に取った値を渡す（props は応答を待つ間に、前後のタスクへ移る、閉じるで変わり、閉じた後は親の今の値を返す）
  // 確認のダイアログは挟まない。消したらトーストの「取り消す」で戻せる
  // keyboard は、キーボードで押したか（click の detail が 0）。真のときだけ、消した直後に「取り消す」へフォーカスを移す
  async function remove(keyboard: boolean): Promise<void> {
    if (task === null || deleting || asking) return;
    deleting = true;
    deleteError = null;
    // 送っている間に前後のタスクへ移っても、取り消しは消したタスクに送る（props は await の後に変わりうる）
    const removed: RestoreTarget = {
      slug,
      workspaceId,
      taskId,
      title: task.title,
      near: adjacent ?? null,
      onchanged,
      onstale,
      onrestored,
      onskipped,
    };
    try {
      const result = await callOperation(taskDelete, { workspace_id: workspaceId, task_id: taskId }, { slug });
      if (!alive) {
        // 削除の要求を送っている間に閉じられた。結果は黙って捨てず、通ったら木を読み直して知らせ、失敗は知らせる
        if (result.ok) {
          announceRemoved(removed);
          onchanged();
        } else if (result.status === 404) {
          onchanged();
        } else {
          showToast(t('taskDeleteFailed'), 'alert');
        }
        return;
      }
      if (result.ok) {
        // 消えたので、書きかけがあっても確かめずに閉じる
        leaving = true;
        const toastId = announceRemoved(removed);
        // キーボードで消したときは、木の読み直しを待つ間に10秒が尽きないよう、フォーカスが着く前から数えを止める
        // （フォーカスが外れると数え直す）。着かなければ、画面側が移した後の focusout で数え直す
        if (keyboard) pauseToast(toastId);
        onremoved(keyboard ? toastId : null, 'deleted');
      } else if (result.status === 401) {
        onstale();
      } else if (result.status === 404) {
        gone();
      } else if (result.status === 403) {
        deleteError = t('taskDeleteForbidden', { leader: t('leader') });
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        deleteError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
        onstale();
      } else if (result.status === 409) {
        // 取り込んだタスクは削除できない
        deleteError = t('taskImportedNoDelete', { task: t('task'), archive: t('archive') });
        void refresh();
      } else {
        deleteError = t('taskDeleteFailed');
      }
    } finally {
      if (alive) deleting = false;
    }
  }

  // ページ全体は画面に h1 が無いので、題を h1 にする。引き出し（横と真ん中）は重なる面の題なので h2 のまま。見た目は .drawer-title で同じ
  const titleTag = $derived(mode === 'page' ? 'h1' : 'h2');

  const status = $derived(
    loadState === 'loading'
      ? t('loading')
      : deleting
        ? t('taskDeleting')
        : completing
          ? t('taskCompleting', { done: t('done') })
          : reopening
            ? t('taskReopening', { done: t('done') })
            : '',
  );
</script>

{#snippet titleView(begin: ((event: Event) => void) | null)}
  <!-- tabindex="-1" は、開いたときに見出しへフォーカスを置くため（キーボードの Tab 順には入らない） -->
  <svelte:element this={titleTag} class="drawer-title" tabindex="-1" bind:this={heading}>
    {#if begin !== null}
      <button class="edit-trigger" type="button" onclick={begin}>
        <span id={titleLabelId}>{task?.title}</span>
        <Icon name="pen" />
        <span class="visually-hidden">{t('taskTitleEditHint', { task: t('task') })}</span>
      </button>
    {:else}
      <span id={titleLabelId}>{task?.title}</span>
    {/if}
  </svelte:element>
{/snippet}

{#snippet bodyView()}
  {#if task?.body_md != null}
    <Markdown source={task.body_md} headingStart={mode === 'page' ? 2 : 3} />
  {:else}
    <div class="doc-box is-empty">{t('bodyEmpty')}</div>
  {/if}
{/snippet}

<Drawer
  {mode}
  onmode={(next, shown) => void requestMode(next, shown)}
  adjacent={adjacent === undefined ? undefined : { hasPrev: adjacent.prev !== null, hasNext: adjacent.next !== null }}
  onstep={(delta, source) => void requestStep(delta, source)}
  initialFocus={arrivedByStep}
  labelledBy={titleLabelId}
  busy={loadState === 'loading'}
  onrequestclose={() => void requestClose()}
>
  {#snippet top()}
    {#if task !== null}
      <FavoriteButton
        targetType="task"
        targetId={task.id}
        title={task.title}
        {workspaceId}
        menuVisible={!workspaceClosed}
      />
      <span class="chip"
        ><Icon name={task.is_imported ? 'link' : 'pen'} />{task.is_imported
          ? t('taskImportedChip', { task: t('task') })
          : t('taskManualChip', { task: t('task') })}</span
      >
      {#if done}<span class="chip is-ok"><Icon name="check" />{t('done')}</span>{/if}
    {/if}
  {/snippet}

  {#if loadState === 'loading'}
    <!-- 読み上げは下の role="status" が伝えるので、見える文字だけにする -->
    <svelte:element this={titleTag} class="drawer-title" tabindex="-1" bind:this={heading}
      ><span id={titleLabelId}>{t('task')}</span></svelte:element
    >
    <p class="field-hint" aria-hidden="true">{t('loading')}</p>
  {:else if loadState === 'failed'}
    <svelte:element this={titleTag} class="drawer-title" tabindex="-1" bind:this={heading}
      ><span id={titleLabelId}>{t('task')}</span></svelte:element
    >
    <div class="callout is-danger" role="alert">
      <Icon name="alert" /><span>{t('taskDrawerLoadFailed', { task: t('task') })}</span>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" bind:this={retryButton} onclick={() => void load()}>{t('retry')}</button>
    </div>
  {:else if task !== null}
    {#if !canWrite}
      <div class="callout is-info" id={readOnlyId}>
        <Icon name="shield" /><span>{t('taskReadOnly', { workspace: t('workspace'), task: t('task') })}</span>
      </div>
    {/if}

    {#if titleEditable}
      <AutoSaveEdit
        value={task.title}
        label={t('fieldTitle')}
        labelHidden
        placeholder={t('taskTitlePlaceholder')}
        problem={titleProblem}
        save={saveTitle}
        normalize={(raw) => raw.trim()}
        ondirty={(value) => (dirty.title = value)}
        onbegin={beginTitle}
      >
        {#snippet view(begin)}{@render titleView(begin)}{/snippet}
      </AutoSaveEdit>
    {:else}
      {@render titleView(null)}
    {/if}
    {#if task.is_imported}
      <span class="props-note">{t('taskImportedNote', { task: t('task') })}</span>
    {/if}

    <dl class="props">
      <div>
        <dt>{t('column')}</dt>
        <dd>
          {#if taskContext.column}<span class="status-dot is-wrap"
              >{taskContext.column.is_done ? t('done') : taskContext.column.name}</span
            >{:else}—{/if}
        </dd>
      </div>
      <div>
        <dt>
          {#if assigneeEditable}<label for={assigneeId}>{t('assignee')}</label>{:else}{t('assignee')}{/if}
        </dt>
        <dd>
          <!-- 名前は隣の選択欄か文字が読むので、アバターはいつも読み上げから外す（二重に読ませない） -->
          {#if assigneeShown === null}
            <Avatar userId={null} decorative />
          {:else}
            <Avatar userId={assigneeShown.id} name={assigneeShown.name} left={assigneeShown.left} decorative />
          {/if}
          {#if assigneeEditable}
            <select
              class="select"
              id={assigneeId}
              bind:this={assigneeSelect}
              onchange={onAssigneeChange}
              onblur={onAssigneeBlur}
              aria-busy={candidatesLoading}
              aria-invalid={assigneeError !== null}
              aria-describedby={[
                candidatesFailed ? assigneeNoteId : null,
                assigneeError !== null ? assigneeErrorId : null,
              ]
                .filter((id) => id !== null)
                .join(' ') || undefined}
            >
              <option value="" selected={assigneeShownId === ''}>{t('unassigned')}</option>
              {#each assigneeOptions as option (option.id)}
                <option value={option.id} selected={option.id === assigneeShownId}
                  >{option.left ? `${option.name}${t('leftMember')}` : option.name}</option
                >
              {/each}
            </select>
            {#if candidatesLoading && !candidatesFailed}
              <!-- 候補を読んでいる間は、選択肢が担当なしと今の担当だけなので、まだ読んでいることを示す -->
              <span class="props-note" role="status">{t('loading')}</span>
            {/if}
            {#if candidatesFailed}
              <span class="props-note" id={assigneeNoteId}
                >{t('assigneeCandidatesFailed', { assignee: t('assignee') })}</span
              >
              <button
                class="btn is-sm is-quiet"
                type="button"
                aria-disabled={candidatesLoading}
                onclick={() => void retryCandidates()}
              >
                {candidatesLoading ? t('retrying') : t('retry')}
              </button>
            {/if}
          {:else}
            <span
              >{task.assignee === null
                ? t('unassigned')
                : `${task.assignee.name}${task.assignee.left ? t('leftMember') : ''}`}</span
            >
          {/if}
          {#if done}
            <span class="props-note"
              ><Icon name="lock" />{t('taskAssigneeLocked', {
                task: t('task'),
                done: t('done'),
                assignee: t('assignee'),
              })}</span
            >
          {/if}
          {#if assigneeError !== null}
            <span class="field-error" id={assigneeErrorId} role="alert"><Icon name="alert" />{assigneeError}</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt id={pointsLabelId}>{t('points')}</dt>
        <dd>
          <div
            class="segmented"
            class:is-readonly={!pointsEditable}
            role="radiogroup"
            aria-labelledby={pointsLabelId}
            aria-describedby={[
              done ? pointsReasonId : !canWrite ? readOnlyId : null,
              pointsError !== null ? pointsErrorId : null,
            ]
              .filter((id) => id !== null)
              .join(' ') || undefined}
          >
            {#each pointChoices as choice (choice)}
              <label>
                <input
                  type="radio"
                  name="{ids}-points"
                  value={choice}
                  checked={pointsShown === choice}
                  disabled={!pointsEditable}
                  onchange={() => choosePoints(choice)}
                  aria-label={choice === null ? t('pointsUnsetTitle') : undefined}
                />
                <span>{choice === null ? t('pointsUnsetMark') : choice}</span>
              </label>
            {/each}
          </div>
          {#if done}
            <span class="props-note" id={pointsReasonId}
              ><Icon name="lock" />{t('taskPointsLocked', {
                task: t('task'),
                done: t('done'),
                points: t('points'),
              })}</span
            >
          {/if}
          {#if pointsError !== null}
            <span class="field-error" id={pointsErrorId} role="alert"><Icon name="alert" />{pointsError}</span>
          {/if}
        </dd>
      </div>
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
            {#if task.due_on !== null}
              <button class="link-btn" type="button" onclick={clearDue}>{t('dueClear')}</button>
            {/if}
          {:else}
            <!-- 読み取り専用では、入力欄にせず文字で出す（空は「—」） -->
            <span id={dueId}>{task.due_on ?? '—'}</span>
          {/if}
          <!-- 期限の印（木の行と同じ部品）。保存した値（task.due_on）で出し直す。完了したタスクは色なし -->
          {#if task.due_on !== null && clock !== null}
            <DueChip dueOn={task.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
          {/if}
          {#if dueError !== null}
            <span class="field-error" id={dueErrorId} role="alert"><Icon name="alert" />{dueError}</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt>{t('drawerParent')}</dt>
        <dd>
          {#if taskContext.story}<Icon name="flag" />
            {taskContext.story.title}{#if taskContext.epic}<span class="props-note">{taskContext.epic.title}</span
              >{/if}{:else}{t('taskParentNone')}{/if}
        </dd>
      </div>
      <div>
        <!-- 入っているスプリント（kit.js の drawer）。入っていなければ「<バックログ>」。出し入れは計画の画面で行う -->
        <dt>{t('sprint')}</dt>
        <dd>
          {#if task.sprint === null}
            <span>{t('sprintNone', { backlog: t('backlog') })}</span>
          {:else if task.sprint.name === null}
            <!-- 名前の無いスプリントは、期間を等幅で出す -->
            <span>{t('sprint')} <span class="mono">{sprintPeriod(task.sprint, t)}</span></span>
          {:else}
            <span>{sprintLabel(task.sprint, t)}</span>
          {/if}
          <span class="props-note">{t('sprintPlanNote', { plan: t('plan') })}</span>
        </dd>
      </div>
      <div>
        <dt id={repositoryLabelId}>{t('repository')}</dt>
        <dd>
          <!-- 1回押して選ぶボタンの並び。選んだら保存する。読み取り専用では、選んだ値の色を保ったまま押せない形にする -->
          <RepositoryPicker
            repositories={definitions?.repositories ?? []}
            value={repositoryShown}
            current={task.repository}
            labelledBy={repositoryLabelId}
            describedBy={[
              !canWrite ? readOnlyId : null,
              definitionsFailed ? definitionsNoteId : null,
              repositoryError !== null ? repositoryErrorId : null,
            ]
              .filter((id) => id !== null)
              .join(' ') || undefined}
            readonly={!canWrite}
            busy={definitionsLoading}
            onchange={chooseRepository}
          />
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
          {#if repositoryError !== null}
            <span class="field-error" id={repositoryErrorId} role="alert"><Icon name="alert" />{repositoryError}</span>
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
                categoryError !== null ? categoryErrorId : null,
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
          {:else}
            <!-- 親から引き継いだ区分と、読み取り専用のときは文字で出す -->
            <span>{task.category?.name ?? t('categoryNone', { category: t('category') })}</span>
          {/if}
          {#if task.story_id !== null}
            <span class="props-note">{t('categoryInherited')}</span>
          {/if}
          {#if categoryError !== null}
            <span class="field-error" id={categoryErrorId} role="alert"><Icon name="alert" />{categoryError}</span>
          {/if}
        </dd>
      </div>
      {#if !task.is_imported}
        <div>
          <dt>{t('fieldLink')}</dt>
          <dd>
            {#if canWrite}
              <AutoSaveEdit
                value={task.link_url ?? ''}
                label={t('fieldLink')}
                labelHidden
                inputType="url"
                placeholder={t('linkPlaceholder')}
                problem={linkProblemMessage}
                save={saveLink}
                normalize={linkForm}
                ondirty={(value) => (dirty.link = value)}
                onbegin={beginLink}
              >
                {#snippet view(begin)}
                  <button class="edit-trigger" class:is-empty={task?.link_url === null} type="button" onclick={begin}>
                    {#if task?.link_url != null}
                      <span class="source-key"><Icon name="link" /> {task.link_url}</span>
                    {:else}
                      <span>{t('linkAdd')}</span>
                    {/if}
                    <Icon name="pen" />
                    <span class="visually-hidden">{t('linkEditHint')}</span>
                  </button>
                  {#if task?.link_url != null}
                    <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める。直している間は、読む形ごと隠れる -->
                    <a
                      class="btn is-sm"
                      href={task.link_url}
                      target="_blank"
                      rel="external noopener noreferrer"
                      aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
                    >
                  {/if}
                {/snippet}
              </AutoSaveEdit>
            {:else if task.link_url !== null}
              <span class="source-key"><Icon name="link" /> {task.link_url}</span>
              <a
                class="btn is-sm"
                href={task.link_url}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
              >
            {:else}
              —
            {/if}
          </dd>
        </div>
      {/if}
      <div>
        <dt>{t('todayMark')}</dt>
        <dd>
          <TodayMarkButton
            title={task.title}
            marked={taskContext.today_on !== null}
            disabled={marking || todayDisabledReason !== null}
            describedby={todayDisabledReason === null ? undefined : todayReasonId}
            onclick={toggleToday}
          />
          {#if taskContext.today_on !== null}<span>{t('todayMark')}</span>{/if}
          {#if todayDisabledReason !== null}<span class="props-note" id={todayReasonId}>{todayDisabledReason}</span
            >{/if}
        </dd>
      </div>
    </dl>

    <!-- 決まった欄（ワークスペースで定義した欄ごと）。本文の前に置く -->
    <TaskFieldValues
      {slug}
      {workspaceId}
      {taskId}
      {fields}
      marksUnfilled={inBacklog && task.completed_at === null}
      {canWrite}
      onsaved={fieldSaved}
      onrefresh={async () => (await refresh()) !== null}
      onmissing={fieldMissing}
      {onstale}
      ondirty={(value) => (dirty.fields = value)}
    />

    <div class="field">
      {#if canWrite}
        <AutoSaveEdit
          value={task.body_md ?? ''}
          label={t('fieldBody')}
          multiline
          markdown={{ slug, workspaceId }}
          hint={t('bodyEditHint')}
          problem={bodyProblem}
          save={saveBody}
          normalize={(raw) => normalizeLongText(raw) ?? ''}
          ondirty={(value) => (dirty.body = value)}
          onbegin={beginBody}
        >
          {#snippet view(begin)}
            <span class="field-label">{t('fieldBody')}</span>
            <!-- 描いた本文そのものを押せば書ける。面いっぱいに透明なボタンを敷き、キーボードと読み上げの入口にする（本文の中のリンクは上に重なり、押せるまま） -->
            <div class="edit-surface" onclick={(event) => beginFromSurface(event, begin)} role="presentation">
              <button class="edit-surface-button" type="button" onclick={begin}
                >{t('bodyEditLabel', { field: t('fieldBody') })}</button
              >
              <div class="edit-surface-body">{@render bodyView()}</div>
            </div>
          {/snippet}
        </AutoSaveEdit>
      {:else}
        <span class="field-label">{t('fieldBody')}</span>
        {@render bodyView()}
      {/if}
    </div>

    <!-- 完了の帯（kit.js の drawerHtml の .done-bar）。完了していて戻せるときは、日時の横に「戻す」 -->
    {#if task.completed_at !== null || canWrite || definitionOfDone !== null}
      <div class="done-bar">
        {#if task.completed_at !== null}
          <!-- 印と日時は .done-bar-done で縦の中心をそろえる（帯は完成の定義に合わせて上端でそろえるため） -->
          <span class="done-bar-done">
            <!-- tabindex="-1" は、完了にした後にフォーカスを置くため（キーボードの Tab 順には入らない） -->
            <span class="hanko" role="img" aria-label={t('done')} tabindex="-1" bind:this={doneMark}
              ><Icon name="check" /><b>{t('doneStamp')}</b></span
            >
            <time datetime={task.completed_at}
              >{t('taskCompletedAt', { done: t('done'), at: formatDateTime(task.completed_at) })}</time
            >
            {#if canWrite && task.reopenable}
              <button
                class="link-btn"
                type="button"
                aria-label={t('taskReopenLabel', { done: t('done'), title: task.title })}
                aria-disabled={reopening}
                onclick={() => void reopen()}>{t('taskReopen')}</button
              >
            {/if}
          </span>
        {:else if canWrite}
          <button
            class="btn is-primary"
            type="button"
            aria-disabled={completing}
            bind:this={completeButton}
            onclick={() => void complete()}
          >
            <Icon name="check" />{t('complete')}
          </button>
        {/if}
        {#if definitionOfDone !== null}
          <!-- 題は h3（引き出しの題が h2）で、本文の見出しは h4 から。長い定義でも帯が伸びないよう、本文は高さを抑えて中で送る。
               送る領域はキーボードで届くようフォーカスを置け、題で名前を付ける -->
          <div class="done-bar-dod">
            <h3 class="done-bar-dod-title" id={dodHeadingId}>{t('dod')}</h3>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (MarkdownBlocks のコードの枠と同じ理由。送る領域にキーボードで届くため) -->
            <div class="done-bar-dod-body" tabindex="0" role="region" aria-labelledby={dodHeadingId}>
              <Markdown source={definitionOfDone} headingStart={4} />
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <TaskThanks
      {slug}
      {workspaceId}
      {task}
      {currentUserId}
      {canWrite}
      {candidates}
      {candidatesLoading}
      {candidatesFailed}
      onretry={() => void loadCandidates()}
      onrefresh={refresh}
      {onstale}
    />

    <!-- コメントと変更の履歴のタブ（kit.js の drawerHtml の .tabs）。中身は外さずに隠す（書きかけのコメントを、タブを切り替えても保つ）。
         左右の矢印キーと Home、End でタブを移り、移った先を選ぶ -->
    <div>
      <div class="tabs" role="tablist" aria-label={t('drawerTabs')}>
        <button
          class="tab"
          type="button"
          role="tab"
          id={commentsTabId}
          aria-controls={commentsPanelId}
          aria-selected={tab === 'comments'}
          tabindex={tab === 'comments' ? 0 : -1}
          onclick={() => selectTab('comments')}
          onkeydown={(event) => void onTabKeydown(event)}
          >{commentCount === null ? t('commentField') : t('commentsTab', { count: commentCount })}</button
        >
        <button
          class="tab"
          type="button"
          role="tab"
          id={historyTabId}
          aria-controls={historyPanelId}
          aria-selected={tab === 'history'}
          tabindex={tab === 'history' ? 0 : -1}
          onclick={() => selectTab('history')}
          onkeydown={(event) => void onTabKeydown(event)}>{t('historyTitle')}</button
        >
      </div>
      <div role="tabpanel" id={commentsPanelId} aria-labelledby={commentsTabId} hidden={tab !== 'comments'}>
        <TaskComments
          bind:this={commentsPanel}
          {slug}
          {workspaceId}
          {taskId}
          {canWrite}
          oncount={(count) => (commentCount = count)}
          ongone={() => {
            if (!taskGone) gone();
          }}
          {onstale}
        />
      </div>
      <!-- 変更の履歴（kit.js の drawerHtml の .history）。tabindex="-1" は、読み直せたときと読み終えたときにフォーカスを置くため -->
      <div
        class="tab-panel"
        role="tabpanel"
        id={historyPanelId}
        aria-labelledby={historyTabId}
        hidden={tab !== 'history'}
        tabindex="-1"
        bind:this={historyPanel}
        aria-busy={historyState === 'loading' || historyReloading}
      >
        <!-- 読み込みの進み具合と、足した件数の読み上げの領域。常に置き、中の文字だけを替える -->
        <span class="visually-hidden" role="status">{historyStatus}</span>
        {#if historyState === 'loading'}
          <p class="field-hint" aria-hidden="true">{t('loading')}</p>
        {:else if historyState === 'failed'}
          <!-- 読み直している間も、失敗の表示とボタンを残す（ボタンは押せなくし、読み直していることを示す） -->
          <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{t('historyLoadFailed')}</span></div>
          <div class="form-actions">
            <button class="btn is-sm" type="button" aria-disabled={historyReloading} onclick={retryHistory}>
              {historyReloading ? t('retrying') : t('retry')}
            </button>
          </div>
        {:else}
          {#if historyReloadFailed}
            <!-- 保存した後の読み直しに失敗した。前に読めた行は残し、上に失敗と「もう一度試す」を添える -->
            <div class="form-actions">
              <span class="field-error" role="alert"><Icon name="alert" />{t('historyReloadFailed')}</span>
              <button class="btn is-sm is-quiet" type="button" aria-disabled={historyReloading} onclick={retryHistory}>
                {historyReloading ? t('retrying') : t('retry')}
              </button>
            </div>
          {/if}
          <ul class="history">
            {#each historyViews as view (view.id)}
              <li>
                <time class="mono" datetime={view.createdAt}>{view.at}</time>
                {#if view.actor !== null}
                  <Avatar userId={view.actor.id} name={view.actorName} decorative />
                {/if}
                <span>{view.actorName}</span>
                <span class="props-note">{view.summary}</span>
                {#if view.lines.length > 0}
                  <ul class="history-changes">
                    {#each view.lines as line, index (index)}
                      <li>
                        {#if line.label !== null}<span class="props-note">{line.label}</span>{/if}
                        <span>{line.text}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {:else}
              <li class="props-note">{t('historyEmpty')}</li>
            {/each}
          </ul>
          {#if historyNext !== null}
            <div class="form-actions">
              <button
                class="btn is-sm"
                type="button"
                aria-disabled={historyMore === 'loading' || historyReloading}
                onclick={() => void showMoreHistory()}
              >
                {historyMore === 'loading' ? t('loading') : t('historyMore')}
              </button>
            </div>
          {/if}
          {#if historyMore === 'failed'}
            <span class="field-error" role="alert"><Icon name="alert" />{t('historyMoreFailed')}</span>
          {/if}
        {/if}
      </div>
    </div>

    {#if canWrite}
      <div class="form-actions">
        {#if task.can_delete}
          <button
            class="btn is-sm is-quiet is-danger"
            type="button"
            aria-disabled={deleting}
            onclick={(event) => void remove(event.detail === 0)}
          >
            <Icon name="trash" />{t('taskDelete', { task: t('task') })}
          </button>
        {:else if task.is_imported}
          <span class="field-hint">{t('taskImportedNoDelete', { task: t('task'), archive: t('archive') })}</span>
        {:else}
          <span class="field-hint">{t('taskDeleteWho', { leader: t('leader') })}</span>
        {/if}
      </div>
      {#if deleteError !== null}
        <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{deleteError}</span></div>
      {/if}
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
