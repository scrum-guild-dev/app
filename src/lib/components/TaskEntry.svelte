<script lang="ts">
  import TodayMarkButton from './TodayMarkButton.svelte';
  import { flashRow } from '../flash-row.ts';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { memberList } from '../../shared/operations/workspace/index.ts';
  import { taskAssign, taskDetail, taskUpdate } from '../../shared/operations/task/index.ts';
  import { TASK_POINT_VALUES } from '../../shared/task.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import type { DefinitionRef } from '../../shared/operations/definition/definition.ts';
  import { dueStatus } from '../../shared/due.ts';
  import { formatMonthDay } from '../format.ts';
  import type { DropRow } from '../backlog-drop.ts';
  import type { BacklogDnd } from '../backlog-dnd.svelte.ts';
  import { taskDetailHref, taskLinkAttrs } from '../drawer.svelte.ts';
  import { sprintShortName } from '../sprint-label.ts';
  import { t } from '../vocabulary.svelte.ts';
  import AttrChip from './AttrChip.svelte';
  import Avatar from './Avatar.svelte';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import RowMenu, { type RowMenuItem } from './RowMenu.svelte';

  // kit.js の entry（台帳の1行）と doneControl。今あるのは、タイトル（`?task=<ID>` へのリンク）、期日の印、ポイント、担当、
  // 完了の操作と完了の印。リンクは詳細の引き出しを開く（/[slug]/w/[id] のレイアウトが `?task=<ID>` を見て置く）。
  // attrs を渡すと（バックログの画面）、ポイントと担当をチップ（AttrChip）にして、押して選んだら task-update、task-assign で保存する。
  // 選んだ値は、送っている間と読み直す間は行に出し、送るのは1本ずつで、送っている間に選び直した分は最後の値だけを送る（引き出しと同じ）。
  // 断られたとき（完了した、所属を外れた、終了した、消えた）は理由をトーストで知らせて元の値に戻す。通ったら attrs.onSaved で木を読み直し、
  // 行と親の集計を直す。完了にした行のチップは押せず、理由が読める。担当の候補は、開くたびに member-list で読む（読めなければ「担当なし」だけを選べ、
  // 「もう一度試す」を添える）。渡さない行（今日やること）は、今までどおりの表示だけ。
  // 親は、その機能の Issue で足す。先頭の枠（.entry の1列目）には、onToggleToday を渡すと今日やるの印の太陽のボタン（.sun）を置く。
  // 押された状態（aria-pressed）が marked で、押すと onToggleToday を呼ぶ。完了にした行と、onToggleToday を渡さない行（書き込めない行）は、枠を空の要素で埋める。
  // 完了にした行に onReopen を渡すと、完了の印の横に「戻す」（.link-btn。TaskDrawer の完了の帯と同じ）を出す。渡さない行（戻せない行、書き込めない行）には出さない。
  // pending の間は、太陽、完了、戻すのどれも押しても無視する（aria-disabled）。
  // 期日の印は、API が返したワークスペースの今日の日付と週の始まり（clock）で決める。完了にした行は色を付けない。
  // 完了の操作が押されると、onComplete を呼ぶ（canComplete が偽で操作を出さない行は渡さなくてよい）。完了にした行は、done を真にして完了の印を付ける。
  // 複数のワークスペースの行を並べる画面（今日やること）は、行ごとに workspaceId（タイトルのリンク先）と workspaceName（.entry-meta の先頭に
  // .tag で出す）を渡す。metaChip は期日の印とは別に添える橙の印（今週が期日の行の「期日は今日」）、metaText は注記（.props-note。持ち越しの日数か、依頼中の行の依頼先の名前）
  // 押したボタンは消えるので、完了の印にフォーカスを移せるよう focusMark() を出す。
  // canComplete が偽（閉じたワークスペース）の行は、完了の操作を出さない。pending の間は押しても無視する（aria-disabled）
  // onMove を渡すと、行の「⋯」のメニューに「上へ」「下へ」（同じ親の中で1つ動かす）を出し、行の中で Alt と ↑ ↓ を押しても同じことをする。
  // 端で動かせない向き（canMoveUp、canMoveDown が偽）は、フォーカスを失わないよう disabled でなく aria-disabled にする。
  // onMoveParent を渡すと、メニューに「親を移す」も出す。完了にした行には出さない。絞り込み中は、画面が onMove を渡さず（並べ替えは隣を使うため）、
  // 「親を移す」だけを出す。
  // タイトルの下（.entry-meta）に、入っているスプリント（kit.js の sprintTag。暦のアイコンと名前、名前が無ければ期間）、
  // 振ったリポジトリ（kit.js の repoTag。git のアイコン）と、showCategory のとき（親のないタスク）だけ区分を出す。
  // 親のあるタスクの区分は親の行に出ているので、繰り返さない。
  // onMove と dnd を渡すと（書き込めるとき）、行の先頭にドラッグのつまみ（.grip。飾りで aria-hidden）を置く。つかむのはここだけで、
  // 完了にした行はつかめない（列だけ空ける）。ほかの行をつかんだときの落とす位置は、行の data-drop（線）で示す。狭い幅と指の画面では CSS がつまみを隠す。
  // ドラッグの代わりは「上へ」「下へ」と Alt と ↑ ↓
  // 完了の印の判を押す動き（.is-new）は、今押した行（justDone が真）だけで再生する。開いた時点で完了済みの行（今日やることの今日完了）は静止した印を出す
  // definitions は、画面が読んだ区分とリポジトリの一覧（読めなかったときは null で、「なし」と今の値だけを選べる）
  type RowAttrs = {
    slug: string;
    workspaceId: string;
    onSaved: () => Promise<void> | void;
    // 見出しの件数へ、保存できたポイントを読み直す前に反映する
    onPointsSaved?: (task: BacklogTask, points: BacklogTask['points']) => void;
    onStale: () => void;
    definitions: { categories: readonly DefinitionRef[]; repositories: readonly DefinitionRef[] } | null;
  };
  let {
    task,
    clock,
    done = false,
    justDone = false,
    addedFlash = false,
    flash = 0,
    pending = false,
    canComplete = true,
    onComplete,
    marked = false,
    onToggleToday,
    onReopen,
    canMoveUp = false,
    canMoveDown = false,
    onMove,
    onMoveParent,
    onDelete,
    showCategory = false,
    dnd,
    taskQuery = '?task=',
    workspaceId,
    workspaceName,
    metaChip,
    metaText,
    attrs,
  }: {
    task: BacklogTask;
    clock: { today: string; weekStart: number };
    done?: boolean;
    justDone?: boolean;
    addedFlash?: boolean;
    flash?: number;
    pending?: boolean;
    canComplete?: boolean;
    onComplete?: (task: BacklogTask) => void;
    marked?: boolean;
    onToggleToday?: (task: BacklogTask) => void;
    onReopen?: (task: BacklogTask) => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMove?: (task: BacklogTask, delta: -1 | 1) => void;
    onMoveParent?: (task: BacklogTask, trigger: HTMLElement) => void;
    onDelete?: (task: BacklogTask, keyboard: boolean) => void;
    showCategory?: boolean;
    dnd?: BacklogDnd;
    taskQuery?: string;
    workspaceId?: string;
    workspaceName?: string;
    metaChip?: string;
    metaText?: string;
    attrs?: RowAttrs;
  } = $props();

  const category = $derived(showCategory ? task.category : null);
  // 完了した行（画面で完了にした直後を含む）には印を出さない
  const unfilled = $derived(task.unfilled && !done);

  const movable = $derived(onMove !== undefined && !done);
  const dropRow = $derived<DropRow>({ kind: 'task', id: task.id });
  const hasGrip = $derived(onMove !== undefined && dnd !== undefined);
  const parentMovable = $derived(onMoveParent !== undefined && !done);
  // 削除は、画面が onDelete を渡し（書き込めるとき）、サーバーが削除できると答えた行（can_delete。作った人とリーダー、取り込んでいない）だけ
  // 完了にした直後の行（読み直すまでその場に残る）には出さない
  const deletable = $derived(onDelete !== undefined && task.can_delete && !done);

  // ---- 担当とポイントのチップ ----
  type PointsChoice = (typeof TASK_POINT_VALUES)[number] | null;
  const pointOptions = [
    { value: '', text: t('pointsUnsetTitle') },
    ...TASK_POINT_VALUES.map((value) => ({ value: String(value), text: t('pointsValue', { value }) })),
  ];
  // 選んで、まだ保存して読み直し終えていない値（行に出す）。送っている間に選び直した分は、最後の値だけを残す
  let pointsPending = $state<{ value: PointsChoice } | null>(null);
  let assigneePending = $state<{ value: string } | null>(null);
  // 最後に送って通った値。送っている間に元の値へ選び直したとき、読み直す前の task（古い値）と比べて「保存済み」と誤らないための基準
  let confirmedPoints: PointsChoice | undefined;
  let confirmedAssignee: string | undefined;
  let pointsSending = false;
  let assigneeSending = false;
  let gone = false;
  $effect(() => () => {
    gone = true;
  });

  const lockedDone = $derived(done);
  const pointsShown = $derived<PointsChoice>(pointsPending !== null ? pointsPending.value : task.points);
  const assigneeShownId = $derived(assigneePending !== null ? assigneePending.value : (task.assignee?.id ?? ''));

  // 担当の候補（今所属している人）。開くたびに読み直し、読めなければ担当なしと今の担当だけを選べる
  let candidates = $state<readonly { id: string; name: string }[] | null>(null);
  let candidatesFailed = $state(false);
  let candidatesLoading = $state(false);
  let candidatesVersion = 0;

  async function loadCandidates(): Promise<void> {
    if (attrs === undefined) return;
    const mine = ++candidatesVersion;
    candidatesLoading = true;
    const result = await callOperation(memberList, { workspace_id: attrs.workspaceId }, { slug: attrs.slug });
    if (gone || mine !== candidatesVersion) return;
    candidatesLoading = false;
    if (result.ok) {
      candidates = result.data.members.map((member) => ({ id: member.id, name: member.name }));
      candidatesFailed = false;
    } else {
      candidatesFailed = true;
    }
  }

  const assigneeOptions = $derived.by(() => {
    const options: { value: string; text: string }[] = [{ value: '', text: t('unassigned') }];
    for (const member of candidates ?? []) options.push({ value: member.id, text: member.name });
    // 今の担当が候補にいないときも、その人を残す。「離脱済み」と言えるのは、候補を読めて、その中にいないときだけ
    // （読む前と読めなかったときは、抜けたかどうかを知らない）
    const current = task.assignee;
    if (current !== null && !options.some((option) => option.value === current.id)) {
      const left = candidates !== null && !candidatesFailed;
      options.push({ value: current.id, text: left ? `${current.name}${t('leftMember')}` : current.name });
    }
    return options;
  });
  const assigneeShown = $derived(assigneeOptions.find((option) => option.value === assigneeShownId) ?? null);
  const assigneeText = $derived(
    assigneeShownId === '' ? t('assignee') : (assigneeShown?.text ?? task.assignee?.name ?? t('assignee')),
  );

  const pointsLockedReason = $derived(
    lockedDone ? t('taskSaveConflict', { task: t('task'), done: t('done'), points: t('points') }) : undefined,
  );
  const assigneeLockedReason = $derived(
    lockedDone ? t('taskAssigneeDone', { task: t('task'), done: t('done'), assignee: t('assignee') }) : undefined,
  );

  function failure(message: string): void {
    if (!gone) showToast(message, 'alert');
  }

  // 木を読み直し、読み直した task の prop が届くまで待つ（onSaved の invalidateAll は data を替えて返るが、
  // 子の prop は次の描画で替わる）。読み直しが例外で抜けても、送る周は止めない（止めると、読み直しの間に選び直した値が
  // 送られないまま行に残る）。読み直せなかった行は、次の読み直しで本当の値に合う
  async function reload(): Promise<void> {
    try {
      await attrs?.onSaved();
    } catch {
      // 知らせは出さない（保存は通っていて、「保存しました」を出した後）
    }
    await tick();
  }

  // 断られた後の読み直しと知らせ。木を読み直して、行を本当の値に戻す
  async function rejected(message: string): Promise<void> {
    failure(message);
    await reload();
  }

  // 失敗の応答を、知らせる文に直す。完了にされていた409は、読み直した今の値で決める
  async function explain(
    result: { status: number; error: { code: string } | null },
    donereason: string,
  ): Promise<string> {
    if (result.status === 401) attrs?.onStale();
    if (result.status === 409 && result.error?.code === 'workspace_closed') {
      attrs?.onStale();
      return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    }
    // 完了にされていたとき（サーバーの conflict は、完了のほか、競合で負けたときにも返る）だけ理由を言う
    if (result.status === 409 && attrs !== undefined) {
      const latest = await callOperation(
        taskDetail,
        { workspace_id: attrs.workspaceId, task_id: task.id },
        { slug: attrs.slug },
      );
      // 読めなかったときは、完了か競合かを言い切らない（消えていれば見つからない、通信などの失敗は保存失敗）
      if (!latest.ok) return latest.status === 404 ? t('taskGone', { task: t('task') }) : t('taskSaveFailed');
      return latest.data.task.completed_at !== null ? donereason : t('taskSaveRaced');
    }
    return result.status === 400 ? t('taskBadRequest') : t('taskSaveFailed');
  }

  function choosePoints(value: string): void {
    pointsPending = { value: value === '' ? null : (Number(value) as PointsChoice) };
    if (!pointsSending) void sendPoints();
  }

  // 通った値（choice）の後始末。選んだ値が通った値のままなら、選んだ値と基準を外す（行は task を出す）。
  // 選び直されていれば、基準を通った値にして残す
  function settlePoints(choice: PointsChoice): void {
    if (pointsPending === null || pointsPending.value === choice) {
      pointsPending = null;
      confirmedPoints = undefined;
    } else {
      confirmedPoints = choice;
    }
  }

  // 1本ずつ送る。送っている間に選び直されたら、最後の選択だけを送る。失敗したら元の値に戻す
  async function sendPoints(): Promise<void> {
    if (attrs === undefined) return;
    pointsSending = true;
    try {
      while (pointsPending !== null) {
        const choice = pointsPending.value;
        if (choice === (confirmedPoints !== undefined ? confirmedPoints : task.points)) {
          pointsPending = null;
          // 先に通った値が残っている（選び直して元に戻した）ので、読み直して行を本当の値に合わせる
          if (confirmedPoints !== undefined) {
            confirmedPoints = undefined;
            await reload();
          }
          // 読み直しの間に選び直されていれば、次の周が送る
          continue;
        }
        const result = await callOperation(
          taskUpdate,
          { workspace_id: attrs.workspaceId, task_id: task.id, points: choice },
          { slug: attrs.slug },
        );
        if (result.ok) {
          attrs.onPointsSaved?.(task, choice);
          // 選び直されていなければ、読み直した値が出るまで選んだ値を見せる
          if (pointsPending !== null && pointsPending.value === choice) {
            showToast(t('taskSaved'), 'check');
            await reload();
          }
          // 最後の選択が通った値なら終える。違えば（送っている間か読み直しの間に選び直された）、通った値を基準に残し、
          // 次の周がそれと比べて送る。選び直したときは、読み直しが失敗するか別の読み直しに置き換えられて task が古いままでも、
          // 基準を誤らない。選び直さずに task が古いまま終わったときは、行が古い値に戻り、その値を選んでも送らない
          // （次の読み直しで合う。task が追いつくまで基準を残すのは、送る状態機械を切り出す #888 で扱う）
          settlePoints(choice);
          continue;
        }
        const message =
          result.status === 404
            ? t('taskGone', { task: t('task') })
            : await explain(result, t('taskSaveConflict', { task: t('task'), done: t('done'), points: t('points') }));
        if (pointsPending === null || pointsPending.value === choice) pointsPending = null;
        confirmedPoints = undefined;
        await rejected(message);
      }
    } finally {
      pointsSending = false;
    }
  }

  function chooseAssignee(value: string): void {
    assigneePending = { value };
    if (!assigneeSending) void sendAssignee();
  }

  function settleAssignee(choice: string): void {
    if (assigneePending === null || assigneePending.value === choice) {
      assigneePending = null;
      confirmedAssignee = undefined;
    } else {
      confirmedAssignee = choice;
    }
  }

  async function sendAssignee(): Promise<void> {
    if (attrs === undefined) return;
    assigneeSending = true;
    try {
      while (assigneePending !== null) {
        const choice = assigneePending.value;
        if (choice === (confirmedAssignee !== undefined ? confirmedAssignee : (task.assignee?.id ?? ''))) {
          assigneePending = null;
          if (confirmedAssignee !== undefined) {
            confirmedAssignee = undefined;
            await reload();
          }
          continue;
        }
        const result = await callOperation(
          taskAssign,
          { workspace_id: attrs.workspaceId, task_id: task.id, assignee_user_id: choice === '' ? null : choice },
          { slug: attrs.slug },
        );
        if (result.ok) {
          if (assigneePending !== null && assigneePending.value === choice) {
            showToast(t('taskSaved'), 'check');
            await reload();
          }
          settleAssignee(choice);
          continue;
        }
        let message: string;
        if (result.status === 404) {
          // タスクが消えたか、選んだ人が所属を外れた。読み直して分ける
          const latest = await callOperation(
            taskDetail,
            { workspace_id: attrs.workspaceId, task_id: task.id },
            { slug: attrs.slug },
          );
          if (!latest.ok && latest.status === 404) message = t('taskGone', { task: t('task') });
          else if (!latest.ok) message = t('taskSaveFailed');
          else {
            void loadCandidates();
            message = t('assigneeNotMember', { workspace: t('workspace'), assignee: t('assignee') });
          }
        } else {
          message = await explain(
            result,
            t('taskAssigneeDone', { task: t('task'), done: t('done'), assignee: t('assignee') }),
          );
        }
        if (assigneePending === null || assigneePending.value === choice) assigneePending = null;
        confirmedAssignee = undefined;
        await rejected(message);
      }
    } finally {
      assigneeSending = false;
    }
  }

  // ---- 期日、リポジトリ、区分のチップ ----
  // 3つとも task-update に1欄ずつ送る。選んだ値は読み直すまで行に出し、送るのは欄ごとに1本ずつで、送っている間に選び直した分は最後の値だけを送る。
  // 断られたら理由をトーストで知らせて元の値に戻す。リポジトリと区分が消えていたとき（404）は、消えたことを言う
  type FieldKey = 'due_on' | 'repository_id' | 'category_id';
  let fieldPending = $state<Partial<Record<FieldKey, { value: string | null }>>>({});
  const fieldSending: Record<FieldKey, boolean> = { due_on: false, repository_id: false, category_id: false };
  const fieldConfirmed: Partial<Record<FieldKey, string | null>> = {};

  function fieldValue(key: FieldKey): string | null {
    if (key === 'due_on') return task.due_on;
    if (key === 'repository_id') return task.repository?.id ?? null;
    return task.category?.id ?? null;
  }
  function fieldShown(key: FieldKey): string | null {
    const pendingValue = fieldPending[key];
    return pendingValue !== undefined ? pendingValue.value : fieldValue(key);
  }

  function chooseField(key: FieldKey, value: string | null): void {
    fieldPending[key] = { value };
    if (!fieldSending[key]) void sendField(key);
  }

  async function sendField(key: FieldKey): Promise<void> {
    if (attrs === undefined) return;
    fieldSending[key] = true;
    try {
      for (;;) {
        const entry = fieldPending[key];
        if (entry === undefined) break;
        const choice = entry.value;
        const base = key in fieldConfirmed ? fieldConfirmed[key]! : fieldValue(key);
        if (choice === base) {
          delete fieldPending[key];
          if (key in fieldConfirmed) {
            delete fieldConfirmed[key];
            await attrs.onSaved();
          }
          break;
        }
        const result = await callOperation(
          taskUpdate,
          { workspace_id: attrs.workspaceId, task_id: task.id, [key]: choice },
          { slug: attrs.slug },
        );
        if (result.ok) {
          fieldConfirmed[key] = choice;
          if (fieldPending[key]?.value === choice) {
            showToast(t('taskSaved'), 'check');
            await attrs.onSaved();
            delete fieldConfirmed[key];
            if (fieldPending[key]?.value === choice) delete fieldPending[key];
          }
          continue;
        }
        let message: string;
        if (result.status === 404) {
          // タスクが消えたか、選んだ区分かリポジトリが消えた。読み直して分ける
          const latest = await callOperation(
            taskDetail,
            { workspace_id: attrs.workspaceId, task_id: task.id },
            { slug: attrs.slug },
          );
          if (!latest.ok && latest.status === 404) message = t('taskGone', { task: t('task') });
          else if (!latest.ok || key === 'due_on') message = t('taskSaveFailed');
          else message = t('definitionRefGone', { kind: key === 'repository_id' ? t('repository') : t('category') });
        } else if (
          result.status === 409 &&
          result.error?.code === 'conflict' &&
          key === 'category_id' &&
          (result.error as { details?: { reason?: string } }).details?.reason === 'has_parent'
        ) {
          message = t('categoryHasParent', { task: t('task'), category: t('category') });
        } else {
          message = await explain(result, t('taskSaveFailed'));
        }
        if (fieldPending[key]?.value === choice) delete fieldPending[key];
        delete fieldConfirmed[key];
        await rejected(message);
      }
    } finally {
      fieldSending[key] = false;
    }
  }

  // 期日の窓の保存。年月日が 1 桁ずつ変わるたびに change が出るので、引き出しと同じく、値が暦としてそろい（年は 4 桁）、
  // 600ms 変わらないか、Enter か欄を離れたときに保存して窓を閉じる。打ちかけでは保存せず、窓も閉じない
  const DUE_DEBOUNCE_MS = 600;
  let dueTimer: ReturnType<typeof setTimeout> | undefined;
  function dueComplete(input: HTMLInputElement): string | null {
    const value = input.value;
    if (input.validity.badInput || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    return Number(value.slice(0, 4)) < 1000 ? null : value;
  }
  function commitDue(input: HTMLInputElement, close: () => void): void {
    clearTimeout(dueTimer);
    if (!input.isConnected) return;
    const value = dueComplete(input);
    if (value === null || value === dueShown) return;
    close();
    chooseField('due_on', value);
  }
  function scheduleDue(input: HTMLInputElement, close: () => void): void {
    clearTimeout(dueTimer);
    dueTimer = setTimeout(() => commitDue(input, close), DUE_DEBOUNCE_MS);
  }
  $effect(() => () => clearTimeout(dueTimer));

  const dueShown = $derived(fieldShown('due_on'));
  const repositoryShownId = $derived(fieldShown('repository_id'));
  const categoryShownId = $derived(fieldShown('category_id'));
  // 親のないタスクだけが区分を選べる。親のあるタスクは、引き継いだ値を文字で出して押せない
  const categoryLocked = $derived(
    showCategory ? undefined : t('categoryHasParent', { task: t('task'), category: t('category') }),
  );

  function dueInfo(value: string): { text: string; tone?: 'danger' | 'warn' } {
    try {
      const date = formatMonthDay(value);
      if (done) return { text: date };
      const status = dueStatus(value, clock.today, clock.weekStart);
      if (status === 'overdue') return { text: t('dueOverdue', { due: t('due'), date }), tone: 'danger' };
      if (status === 'today') return { text: t('dueToday'), tone: 'warn' };
      if (status === 'this_week') return { text: t('dueThisWeek', { date }), tone: 'warn' };
      return { text: date };
    } catch {
      return { text: value };
    }
  }
  const dueView = $derived(dueShown === null ? null : dueInfo(dueShown));

  // 選択肢は「なし」と一覧。今の値が一覧に無い（読めなかった、直後に消えた）ときも残す
  function definitionOptions(
    list: readonly DefinitionRef[] | undefined,
    current: DefinitionRef | null,
    none: string,
  ): { value: string; text: string }[] {
    const options = [{ value: '', text: none }, ...(list ?? []).map((item) => ({ value: item.id, text: item.name }))];
    if (current !== null && !options.some((option) => option.value === current.id)) {
      options.push({ value: current.id, text: current.name });
    }
    return options;
  }
  const repositoryOptions = $derived(
    definitionOptions(attrs?.definitions?.repositories, task.repository, t('repositoryNone')),
  );
  const categoryOptions = $derived(
    definitionOptions(attrs?.definitions?.categories, task.category, t('categoryNone', { category: t('category') })),
  );
  const repositoryText = $derived(
    repositoryOptions.find((option) => option.value === (repositoryShownId ?? ''))?.text ?? t('repository'),
  );
  const categoryText = $derived(
    categoryOptions.find((option) => option.value === (categoryShownId ?? ''))?.text ?? t('category'),
  );

  function move(delta: -1 | 1): void {
    if (!movable || (delta < 0 ? !canMoveUp : !canMoveDown)) return;
    onMove?.(task, delta);
  }

  // 行の中にフォーカスがあるときの Alt と ↑ ↓。端でも画面に渡す（画面が、動かせないことを読み上げる）
  function keydown(event: KeyboardEvent): void {
    if (!movable || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    onMove?.(task, event.key === 'ArrowUp' ? -1 : 1);
  }

  let mark = $state<HTMLElement>();
  // タイトルのリンクは、今のワークスペースの画面に `?task=<ID>` を付ける。絞り込みの問い合わせ（assignee、q など）は残す。
  // 問い合わせの前半（taskQuery。`?...&task=` か `?task=`）は画面が1回だけ組んで渡し、行は ID だけを足す
  const taskHref = $derived(
    resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: workspaceId ?? page.params.id ?? '' }),
  );

  export function focusMark(): void {
    mark?.focus();
  }

  // 完了の丸のほかの操作は、行の「⋯」（RowMenu）にまとめる。親を移すと行は別の親の下に作り直されるので、
  // 画面が新しい行の「⋯」へフォーカスを戻せるよう focusMoveParent() を出す
  let menu = $state<ReturnType<typeof RowMenu>>();
  export function focusMoveParent(): void {
    menu?.focus();
  }
  const menuItems = $derived<RowMenuItem[]>([
    ...(movable
      ? [
          { key: 'up', label: t('moveUp'), icon: 'up' as const, disabled: !canMoveUp, onselect: () => move(-1) },
          { key: 'down', label: t('moveDown'), icon: 'down' as const, disabled: !canMoveDown, onselect: () => move(1) },
        ]
      : []),
    ...(parentMovable
      ? [
          {
            key: 'swap',
            label: t('moveParent'),
            icon: 'swap' as const,
            onselect: (trigger: HTMLButtonElement) => onMoveParent?.(task, trigger),
          },
        ]
      : []),
    // 末尾の危険色の項目。確認は挟まない（消したらトーストの「取り消す」で戻せる）
    ...(deletable
      ? [
          {
            key: 'delete',
            label: t('taskDelete', { task: t('task') }),
            icon: 'trash' as const,
            danger: true,
            onselect: (_trigger: HTMLButtonElement, keyboard: boolean) => onDelete?.(task, keyboard),
          },
        ]
      : []),
  ]);
</script>

<!-- キーは中のリンクとボタンから届く。行そのものはフォーカスを受けない -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- data-row-id は、画面が読み直した後に同じ行の操作へフォーカスを戻すのに使う -->
<div
  class="entry"
  class:has-attrs={attrs !== undefined}
  class:is-done={done}
  class:has-grip={hasGrip}
  class:is-dragging={dnd?.isDragging('task', task.id)}
  class:is-dropped={addedFlash || dnd?.isFlashing('task', task.id)}
  use:flashRow={flash}
  onkeydown={keydown}
  data-row-id={task.id}
  data-drop={dnd?.markOf(dropRow)}
  {@attach dnd?.target(dropRow)}
>
  {#if hasGrip}
    {#if movable}
      <span class="grip" aria-hidden="true" {@attach dnd?.handle({ kind: 'task', id: task.id })}
        ><Icon name="grip" /></span
      >
    {:else}
      <span class="grip is-off" aria-hidden="true"></span>
    {/if}
  {/if}
  {#if onToggleToday !== undefined && !done}
    <TodayMarkButton title={task.title} {marked} disabled={pending} onclick={() => onToggleToday?.(task)} />
  {:else}
    <span aria-hidden="true"></span>
  {/if}
  <div class="entry-main">
    <!-- 横と真ん中のときは、押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す）。ページ全体の既定では taskLinkAttrs が reset を外し、先頭から表示する -->
    <!-- eslint-disable svelte/no-navigation-without-resolve -- href は resolve した経路に ?task=<ID> を足したもの、またはその詳細ページ -->
    <a
      class="entry-title"
      href={taskDetailHref(`${taskHref}${taskQuery}${encodeURIComponent(task.id)}`)}
      data-task-id={task.id}
      {...taskLinkAttrs()}>{task.title}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {#if workspaceName !== undefined || (attrs === undefined && (task.repository !== null || category !== null)) || task.sprint !== null || unfilled || metaChip !== undefined || metaText !== undefined}
      <span class="entry-meta">
        {#if workspaceName !== undefined}<span class="tag">{workspaceName}</span>{/if}
        {#if task.sprint !== null}
          <DefinitionChip kind="sprint" name={sprintShortName(task.sprint, t)} mono={task.sprint.name === null} />
        {/if}
        <!-- チップのある行（attrs）は、リポジトリと区分を右端のチップが出す -->
        {#if attrs === undefined && task.repository !== null}
          <DefinitionChip kind="repository" name={task.repository.name} />
        {/if}
        {#if attrs === undefined && category !== null}
          <DefinitionChip kind="category" name={category.name} />
        {/if}
        <!-- 決まった欄が未記入（完了していないタスクだけ。見本の taskFlags の .chip.is-todo。色だけに頼らず、鉛筆の印と文字で示す） -->
        {#if unfilled}
          <span class="chip is-todo"><Icon name="pen" />{t('unfilledChip', { detail: t('detail') })}</span>
        {/if}
        {#if metaChip !== undefined}<span class="chip is-warn">{metaChip}</span>{/if}
        {#if metaText !== undefined}<span class="props-note">{metaText}</span>{/if}
      </span>
    {/if}
  </div>
  <div class="entry-end">
    <div class="entry-attributes">
      <div
        class="entry-chips"
        role={attrs !== undefined ? 'group' : undefined}
        aria-label={attrs !== undefined ? task.title : undefined}
      >
        {#if attrs === undefined && task.due_on !== null}
          <DueChip dueOn={task.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
        {/if}
        {#if attrs !== undefined}
          <AttrChip
            attr={t('due')}
            text={dueView === null ? t('due') : dueView.text}
            unset={dueView === null}
            tone={dueView?.tone}
            options={[]}
            current={dueShown ?? ''}
            onselect={(value) => chooseField('due_on', value === '' ? null : value)}
          >
            {#snippet panel(close)}
              <div>
                <input
                  class="input"
                  type="date"
                  aria-label={t('due')}
                  value={dueShown ?? ''}
                  onchange={(event) => scheduleDue(event.currentTarget, close)}
                  onkeydown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitDue(event.currentTarget, close);
                    }
                  }}
                  onblur={(event) => commitDue(event.currentTarget, close)}
                />
                {#if dueShown !== null}
                  <button
                    class="menu-item"
                    type="button"
                    onclick={() => {
                      clearTimeout(dueTimer);
                      close();
                      chooseField('due_on', null);
                    }}>{t('dueClear')}</button
                  >
                {/if}
              </div>
            {/snippet}
          </AttrChip>
          <AttrChip
            attr={t('repository')}
            text={repositoryShownId === null ? t('repository') : repositoryText}
            unset={repositoryShownId === null}
            options={repositoryOptions}
            current={repositoryShownId ?? ''}
            onselect={(value) => chooseField('repository_id', value === '' ? null : value)}
          />
          <AttrChip
            attr={t('category')}
            text={categoryShownId === null ? t('category') : categoryText}
            unset={categoryShownId === null}
            options={categoryOptions}
            current={categoryShownId ?? ''}
            onselect={(value) => chooseField('category_id', value === '' ? null : value)}
            locked={categoryLocked}
          />
          <AttrChip
            attr={t('points')}
            text={pointsShown === null ? t('points') : t('pointsValue', { value: pointsShown })}
            unset={pointsShown === null}
            options={pointOptions}
            current={pointsShown === null ? '' : String(pointsShown)}
            onselect={choosePoints}
            locked={pointsLockedReason}
          />
          <AttrChip
            attr={t('assignee')}
            text={assigneeText}
            unset={assigneeShownId === ''}
            options={assigneeOptions}
            current={assigneeShownId}
            onselect={chooseAssignee}
            locked={assigneeLockedReason}
            onopen={() => void loadCandidates()}
            retry={candidatesFailed ? () => void loadCandidates() : undefined}
            retrying={candidatesLoading}
            failedNote={t('assigneeCandidatesFailed', { assignee: t('assignee') })}
            busy={candidatesLoading}
          >
            {#snippet lead()}
              {#if assigneeShownId === ''}
                <Avatar userId={null} decorative />
              {:else}
                <Avatar userId={assigneeShownId} name={assigneeShown?.text ?? ''} decorative />
              {/if}
            {/snippet}
          </AttrChip>
        {:else if task.points === null}
          <span class="pts is-none" role="img" aria-label={t('pointsUnsetTitle')} title={t('pointsUnsetTitle')}
            >{t('pointsUnsetMark')}</span
          >
        {:else}
          <span
            class="pts"
            role="img"
            aria-label={t('pointsLabel', { points: t('points'), value: task.points })}
            title={t('pointsLabel', { points: t('points'), value: task.points })}>{task.points}</span
          >
        {/if}
        {#if attrs !== undefined}
          <!-- 担当は、上のチップが出している -->
        {:else if task.assignee === null}
          <Avatar userId={null} />
        {:else}
          <Avatar userId={task.assignee.id} name={task.assignee.name} />
        {/if}
      </div>
    </div>
    <div class="entry-actions">
      {#if menuItems.length > 0}
        <RowMenu title={task.title} items={menuItems} bind:this={menu} />
      {/if}
      {#if done}
        <!-- tabindex="-1" は、完了にした後にフォーカスを置くため（キーボードの Tab 順には入らない） -->
        <span
          class="hanko"
          class:is-new={justDone}
          role="img"
          aria-label={t('doneMarkLabel', { title: task.title, done: t('done') })}
          tabindex="-1"
          bind:this={mark}
        >
          <Icon name="check" /><b>{t('doneStamp')}</b>
        </span>
        {#if onReopen !== undefined}
          <button
            class="link-btn"
            type="button"
            aria-label={t('taskReopenLabel', { done: t('done'), title: task.title })}
            aria-disabled={pending}
            onclick={() => {
              if (!pending) onReopen(task);
            }}>{t('taskReopen')}</button
          >
        {/if}
      {:else if canComplete}
        <button
          class="done-btn"
          type="button"
          aria-label={t('taskCompleteLabel', { complete: t('complete'), title: task.title })}
          title={t('complete')}
          aria-disabled={pending}
          onclick={() => {
            if (!pending) onComplete?.(task);
          }}
        >
          <Icon name="check" />
        </button>
      {/if}
    </div>
  </div>
</div>
