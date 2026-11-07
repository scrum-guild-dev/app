<script lang="ts">
  import { tick } from 'svelte';
  import { afterNavigate, beforeNavigate, goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import TaskDrawer from '../../../../../../lib/components/TaskDrawer.svelte';
  import {
    consumeOverlayHandoff,
    openTaskTab,
    setTaskOpenMode,
    type TaskOpenMode,
  } from '../../../../../../lib/drawer.svelte.ts';
  import { focusFirstTaskRow, focusIsFree, focusPageHeading } from '../../../../../../lib/focus-heading.ts';
  import { focusToastAction } from '../../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../../lib/vocabulary.svelte.ts';
  import type { PageData } from './$types';

  // タスクだけの URL。一覧を重ねず、TaskDrawer の中身をページ全体で出す。
  // 閉じる先は、アプリ内で来たとき（一覧のリンクを押した、goto で来た）は履歴を戻って直前の画面（一覧のスクロール位置も戻る）、
  // 直接開いた（再読み込みを含む）ときはバックログ。引き出しから「ページ全体」を選んだときは、履歴を置き換えて来るので、
  // 前の履歴が一覧ではない。このときは戻り先の URL へ置き換えて移る
  let { data }: { data: PageData } = $props();
  const workspace = $derived(data.workspace);
  let returnTo: string | null = null;
  let canGoBack = false;
  let afterReturn: (() => Promise<void>) | null = null;

  afterNavigate(({ from, type }) => {
    // 直接開いた（type は enter）ときも `from` は渡るが、`from.url` は null
    if (!from?.url || from.params?.taskId) return;
    const handoff = consumeOverlayHandoff();
    const url = new URL(from.url);
    const hadTask = url.searchParams.has('task');
    url.searchParams.delete('task');
    returnTo = url.pathname + url.search + url.hash;
    canGoBack = !handoff && !hadTask && (type === 'link' || type === 'goto');
  });

  // history.back() が終わったら（このページは外れて消えるが、この関数は残る）、閉じた後の仕上げをする
  beforeNavigate((navigation) => {
    if (afterReturn === null || navigation.type !== 'popstate') return;
    const run = afterReturn;
    afterReturn = null;
    void navigation.complete.then(run, () => {});
  });

  function backlog(): string {
    return resolve('/[slug]/w/[id]', { slug: data.slug, id: page.params.id ?? '' });
  }

  async function leave(after: () => Promise<void>): Promise<void> {
    if (canGoBack) {
      afterReturn = after;
      history.back();
      return;
    }
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- アプリ内で来た解決済みの URL か resolve したバックログ
    await goto(returnTo ?? backlog(), { replace: true });
    await after();
  }

  async function close(removed = false, toastId: number | null = null): Promise<void> {
    const id = page.params.taskId ?? '';
    await leave(async () => {
      if (removed) await invalidate('app:backlog-tree');
      await tick();
      const row = !removed && document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
      if (row) row.focus();
      else focusPageHeading();
      // キーボードで削除したときは、見出しへ移した後に「取り消す」へフォーカスを移す
      if (toastId !== null) await focusToastAction(toastId);
    });
  }

  // 「取り消す」で戻した（引き出しと同じ）。木を読み直し、押したボタンにフォーカスがあり、待つ間に利用者が別へ移っていなければ、
  // 戻したタスクの題のリンクへ（無ければ見出しへ）移す
  async function restored(restoredId: string, focus: boolean): Promise<void> {
    await invalidate('app:backlog-tree');
    await tick();
    if (focus && focusIsFree()) focusFirstTaskRow([restoredId]);
  }

  // フォーカスがある「取り消す」のトーストを Esc で閉じた。消した行の次の行、無ければ前の行、無ければ見出しへ移す
  function skipped(near: { prev: string | null; next: string | null } | null): void {
    void tick().then(() => focusFirstTaskRow([near?.next ?? null, near?.prev ?? null]));
  }

  // 帯で形を替える（書きかけの確認は TaskDrawer が済ませている）。移れなかったとき（新しいタブを開けなかった）は false を返し、
  // ページ全体も既定もそのままにする
  function changeMode(mode: TaskOpenMode): boolean {
    const id = page.params.taskId ?? '';
    if (mode === 'tab') {
      if (!openTaskTab(page.url.pathname)) return false;
      setTaskOpenMode(mode);
      void close();
      return true;
    }
    setTaskOpenMode(mode);
    // 戻り先の画面に詳細を重ねる。戻り先は履歴の 1 つ前なので、戻ってから置き換えて、同じ画面が履歴に 2 つ並ばないようにする
    void leave(async () => {
      const url = new URL(location.href);
      url.searchParams.set('task', id);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 戻り先の解決済み URL にタスクの問い合わせだけを足す
      await goto(url, { replace: true, reset: false });
    });
    return true;
  }
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('detail'), app: t('appName') })}</title>
</svelte:head>

{#if workspace}
  {#key page.params.taskId}
    <TaskDrawer
      mode="page"
      onmode={changeMode}
      slug={data.slug}
      workspaceId={workspace.id}
      taskId={page.params.taskId ?? ''}
      currentUserId={data.organization?.me.id ?? null}
      canWrite={workspace.closedAt === null}
      definitionOfDone={workspace.definitionOfDone}
      onclose={() => void close()}
      onchanged={() => void invalidate('app:backlog-tree')}
      onstale={() => void invalidate('app:workspace')}
      onremoved={(toastId) => void close(true, toastId)}
      onrestored={restored}
      onskipped={skipped}
    />
  {/key}
{/if}
