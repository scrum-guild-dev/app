import { beforeEach, describe, expect, test, vi } from 'vitest';

// DOM 環境が無いので、画面に触れる部品（api、toast、focus-heading、task-order、vocabulary）を差し替え、document と CSS は最小の偽物を置く
const mocks = vi.hoisted(() => ({
  callOperation: vi.fn(),
  showToast: vi.fn<(message: string) => number>(() => 7),
  pauseToast: vi.fn(),
  resumeToast: vi.fn(),
  focusToastAction: vi.fn(async () => true),
  focusIsFree: vi.fn(() => true),
  focusPageHeading: vi.fn(),
  focusFirstTaskRow: vi.fn(),
  visibleTaskIds: vi.fn<(root: unknown) => string[]>(() => []),
}));

vi.mock('./api.ts', () => ({ callOperation: mocks.callOperation }));
vi.mock('./toast.svelte.ts', () => ({
  showToast: mocks.showToast,
  pauseToast: mocks.pauseToast,
  resumeToast: mocks.resumeToast,
  focusToastAction: mocks.focusToastAction,
}));
vi.mock('./focus-heading.ts', () => ({
  focusIsFree: mocks.focusIsFree,
  focusPageHeading: mocks.focusPageHeading,
  focusFirstTaskRow: mocks.focusFirstTaskRow,
}));
vi.mock('./task-order.ts', () => ({ visibleTaskIds: mocks.visibleTaskIds }));
vi.mock('./vocabulary.svelte.ts', () => ({ t: (key: string) => key }));

import {
  adjacentRowsOf,
  reloadFailureMessage,
  removeFromList,
  restoreRemoved,
  urlWithoutOpenTask,
  type RemoveFromListArgs,
} from './task-removal.ts';

function failure(status: number, code?: string) {
  return { ok: false as const, status, error: code === undefined ? null : { code, message: '', details: undefined } };
}

function args(overrides: Partial<RemoveFromListArgs> = {}): RemoveFromListArgs {
  return {
    slug: 'aoba',
    workspaceId: 'w1',
    taskId: 't1',
    title: '題',
    keyboard: false,
    reload: vi.fn(async () => {}),
    onstale: vi.fn(),
    onrestored: vi.fn(async () => {}),
    onskipped: vi.fn(),
    ...overrides,
  };
}

const toastMessages = () => mocks.showToast.mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.focusIsFree.mockReturnValue(true);
  mocks.focusToastAction.mockResolvedValue(true);
  mocks.visibleTaskIds.mockReturnValue([]);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('location', { href: 'http://localhost/aoba/w/w1' });
});

describe('removeFromList', () => {
  test('通ると「取り消す」付きのトーストを出して読み直す。マウスでは数えを止めず、フォーカスも動かさない', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    const a = args();
    await removeFromList(a);
    expect(toastMessages()).toEqual(['taskDeleted']);
    expect(a.reload).toHaveBeenCalledTimes(1);
    expect(mocks.pauseToast).not.toHaveBeenCalled();
    expect(mocks.focusToastAction).not.toHaveBeenCalled();
  });

  test('キーボードでは数えを止め、読み直した後に「取り消す」へフォーカスを移す', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    await removeFromList(args({ keyboard: true }));
    expect(mocks.pauseToast).toHaveBeenCalledWith(7);
    expect(mocks.focusToastAction).toHaveBeenCalledWith(7);
    expect(mocks.resumeToast).not.toHaveBeenCalled();
    expect(mocks.focusPageHeading).not.toHaveBeenCalled();
  });

  test('キーボードで、待つ間に別の所へフォーカスを移した人からは奪わず、数えを戻す', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    mocks.focusIsFree.mockReturnValue(false);
    await removeFromList(args({ keyboard: true }));
    expect(mocks.resumeToast).toHaveBeenCalledWith(7);
    expect(mocks.focusToastAction).not.toHaveBeenCalled();
    expect(mocks.focusPageHeading).not.toHaveBeenCalled();
  });

  test('「取り消す」に着かなかったときだけ、見出しへフォーカスを置く（フォーカスが空いているとき）', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    mocks.focusToastAction.mockResolvedValue(false);
    await removeFromList(args({ keyboard: true }));
    expect(mocks.focusPageHeading).toHaveBeenCalledTimes(1);
  });

  test('読み直しが失敗しても reject せず、失敗を文で知らせ、キーボードでは数えを戻す', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    const reload = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(removeFromList(args({ keyboard: true, reload }))).resolves.toBeUndefined();
    expect(toastMessages()).toContain('taskListReloadFailed');
    expect(mocks.resumeToast).toHaveBeenCalledWith(7);
    expect(mocks.focusToastAction).not.toHaveBeenCalled();
  });

  // #979: 印を置く画面は onreloadfailed を渡す。トーストは消えるので、画面に残す印に任せ、トーストは出さない
  test('onreloadfailed を渡すと、読み直しの失敗はトーストでなく画面の印に任せる（消した後は deleted）', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    const reload = vi.fn(async () => {
      throw new Error('network');
    });
    const onreloadfailed = vi.fn();
    await expect(removeFromList(args({ keyboard: true, reload, onreloadfailed }))).resolves.toBeUndefined();
    expect(onreloadfailed).toHaveBeenCalledExactlyOnceWith('deleted');
    expect(toastMessages()).toEqual(['taskDeleted']);
    expect(mocks.resumeToast).toHaveBeenCalledWith(7);
  });

  test('onreloadfailed を渡すと、断られた後の読み直しの失敗は stale で渡す（403、404、409）', async () => {
    for (const result of [failure(403, 'forbidden'), failure(404, 'not_found'), failure(409, 'conflict')]) {
      vi.clearAllMocks();
      mocks.callOperation.mockResolvedValue(result);
      const onreloadfailed = vi.fn();
      const reload = vi.fn(async () => {
        throw new Error('network');
      });
      await removeFromList(args({ reload, onreloadfailed }));
      expect(onreloadfailed).toHaveBeenCalledExactlyOnceWith('stale');
      expect(toastMessages()).not.toContain('taskListReloadFailed');
    }
  });

  test('読み直せたときは onreloadfailed を呼ばない', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    const onreloadfailed = vi.fn();
    await removeFromList(args({ onreloadfailed }));
    expect(onreloadfailed).not.toHaveBeenCalled();
  });

  test('取り消した後の読み直しの失敗は restored で渡す（トーストの「取り消す」から）', async () => {
    mocks.callOperation.mockResolvedValueOnce({ ok: true, data: null });
    const onreloadfailed = vi.fn();
    const onrestored = vi.fn(async () => {
      throw new Error('network');
    });
    await removeFromList(args({ onrestored, onreloadfailed }));
    const action = (mocks.showToast.mock.calls[0] as unknown[])[2] as { run: (focused: boolean) => void };
    mocks.callOperation.mockResolvedValueOnce({ ok: true, data: { cleared: [] } });
    action.run(false);
    await vi.waitFor(() => expect(onreloadfailed).toHaveBeenCalledExactlyOnceWith('restored'));
    expect(toastMessages()).toEqual(['taskDeleted', 'taskRestored']);
  });

  test('印の文は、消した、戻したことが済んでいると分かる形にする', () => {
    expect(reloadFailureMessage('deleted')).toBe('taskDeletedReloadFailed');
    expect(reloadFailureMessage('restored')).toBe('taskRestoredReloadFailed');
    expect(reloadFailureMessage('stale')).toBe('taskListStaleReloadFailed');
  });

  test('引き出しが開いているタスクを消したら、引き出しを閉じる', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    vi.stubGlobal('location', { href: 'http://localhost/aoba/w/w1?task=t1&q=a' });
    const closeDrawer = vi.fn(async () => {});
    await removeFromList(args({ closeDrawer }));
    expect(closeDrawer).toHaveBeenCalledWith('/aoba/w/w1?q=a');
  });

  test('引き出しを閉じるのは読み直しより前。閉じるのに失敗しても読み直しへ進み、失敗の文は出さない', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    vi.stubGlobal('location', { href: 'http://localhost/aoba/w/w1?task=t1' });
    const order: string[] = [];
    const a = args({
      closeDrawer: async () => {
        order.push('close');
        throw new Error('navigation');
      },
      reload: async () => {
        order.push('reload');
      },
    });
    await removeFromList(a);
    expect(order).toEqual(['close', 'reload']);
    expect(toastMessages()).toEqual(['taskDeleted']);
  });

  test('別のタスクの引き出しが開いているときは、閉じない', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    vi.stubGlobal('location', { href: 'http://localhost/aoba/w/w1?task=other' });
    const closeDrawer = vi.fn(async () => {});
    await removeFromList(args({ closeDrawer }));
    expect(closeDrawer).not.toHaveBeenCalled();
  });

  test('引き出しを閉じる関数が同期に throw しても、読み直しへ進み、キーボードの数えを戻せる', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: null });
    vi.stubGlobal('location', { href: 'http://localhost/aoba/w/w1?task=t1' });
    const a = args({
      keyboard: true,
      closeDrawer: () => {
        throw new Error('sync');
      },
    });
    await expect(removeFromList(a)).resolves.toBeUndefined();
    expect(a.reload).toHaveBeenCalledTimes(1);
    expect(mocks.focusToastAction).toHaveBeenCalledWith(7);
  });

  test('404 で読み直しが失敗しても reject せず、キーボードなら見出しへフォーカスを置く', async () => {
    mocks.callOperation.mockResolvedValue(failure(404, 'not_found'));
    const reload = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(removeFromList(args({ keyboard: true, reload }))).resolves.toBeUndefined();
    expect(toastMessages()).toEqual(['taskGone', 'taskListReloadFailed']);
    expect(mocks.focusPageHeading).toHaveBeenCalledTimes(1);
  });

  test('401 は onstale だけ。トーストも読み直しもしない', async () => {
    mocks.callOperation.mockResolvedValue(failure(401));
    const a = args();
    await removeFromList(a);
    expect(a.onstale).toHaveBeenCalledTimes(1);
    expect(a.reload).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  test('404 は「見つかりません」を知らせて読み直す。キーボードのときだけ見出しへフォーカスを置く', async () => {
    mocks.callOperation.mockResolvedValue(failure(404, 'not_found'));
    const mouse = args();
    await removeFromList(mouse);
    expect(toastMessages()).toEqual(['taskGone']);
    expect(mouse.reload).toHaveBeenCalledTimes(1);
    expect(mocks.focusPageHeading).not.toHaveBeenCalled();

    await removeFromList(args({ keyboard: true }));
    expect(mocks.focusPageHeading).toHaveBeenCalledTimes(1);
  });

  test('403 は権限の文を出して読み直す', async () => {
    mocks.callOperation.mockResolvedValue(failure(403, 'forbidden'));
    const a = args();
    await removeFromList(a);
    expect(toastMessages()).toEqual(['taskDeleteForbidden']);
    expect(a.reload).toHaveBeenCalledTimes(1);
  });

  test('409 のワークスペースの終了は onstale、取り込んだタスクは文を出して読み直す', async () => {
    mocks.callOperation.mockResolvedValue(failure(409, 'workspace_closed'));
    const closed = args();
    await removeFromList(closed);
    expect(toastMessages()).toEqual(['workspaceClosedReadOnly']);
    expect(closed.onstale).toHaveBeenCalledTimes(1);
    expect(closed.reload).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.callOperation.mockResolvedValue(failure(409, 'conflict'));
    const imported = args();
    await removeFromList(imported);
    expect(toastMessages()).toEqual(['taskImportedNoDelete']);
    expect(imported.reload).toHaveBeenCalledTimes(1);
  });

  test('それ以外の失敗は文を出すだけで、読み直さない', async () => {
    mocks.callOperation.mockResolvedValue(failure(500));
    const a = args();
    await removeFromList(a);
    expect(toastMessages()).toEqual(['taskDeleteFailed']);
    expect(a.reload).not.toHaveBeenCalled();
  });

  test('送っている間に同じタスクをもう一度選んでも、2回目は送らない。終われば送れる', async () => {
    let finish!: (value: unknown) => void;
    mocks.callOperation.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const first = removeFromList(args());
    await removeFromList(args());
    expect(mocks.callOperation).toHaveBeenCalledTimes(1);
    finish(failure(500));
    await first;

    mocks.callOperation.mockResolvedValueOnce(failure(500));
    await removeFromList(args());
    expect(mocks.callOperation).toHaveBeenCalledTimes(2);
  });
});

describe('urlWithoutOpenTask', () => {
  test('開いているタスクだけ task、story、epic_id を外す。ほかの問い合わせは残す', () => {
    expect(urlWithoutOpenTask('http://x/a/w/1?task=t1&story=s&epic_id=e&q=z', 't1')).toBe('/a/w/1?q=z');
    expect(urlWithoutOpenTask('http://x/a/w/1?task=t1', 't1')).toBe('/a/w/1');
    expect(urlWithoutOpenTask('http://x/a/w/1?task=t2', 't1')).toBeNull();
    expect(urlWithoutOpenTask('http://x/a/w/1', 't1')).toBeNull();
  });
});

describe('adjacentRowsOf', () => {
  test('見える行の順で前後を返す。端は null', () => {
    mocks.visibleTaskIds.mockReturnValue(['a', 'b', 'c']);
    expect(adjacentRowsOf('b')).toEqual({ prev: 'a', next: 'c' });
    expect(adjacentRowsOf('a')).toEqual({ prev: null, next: 'b' });
    expect(adjacentRowsOf('c')).toEqual({ prev: 'b', next: null });
  });

  test('畳んだ枝の中の行と重複は、visibleTaskIds が外した順を使う。画面に無ければ null', () => {
    mocks.visibleTaskIds.mockReturnValue(['a', 'c']);
    expect(adjacentRowsOf('b')).toBeNull();
    expect(adjacentRowsOf('a')).toEqual({ prev: null, next: 'c' });
  });

  test('スプリントのボードでは、同じ列（.board-col）の中だけを見る。無ければ document 全体', () => {
    const column = { name: 'column' };
    const own = { closest: (selector: string) => (selector === '.board-col' ? column : null) };
    vi.stubGlobal('document', { querySelector: () => own });
    mocks.visibleTaskIds.mockImplementation((root) => (root === column ? ['x', 'y'] : ['x', 'y', 'z']));
    expect(adjacentRowsOf('y')).toEqual({ prev: 'x', next: null });

    const bare = { closest: () => null };
    const doc = { querySelector: () => bare };
    vi.stubGlobal('document', doc);
    expect(adjacentRowsOf('y')).toEqual({ prev: 'x', next: 'z' });
    expect(mocks.visibleTaskIds).toHaveBeenLastCalledWith(doc);
  });
});

describe('restoreRemoved', () => {
  function target(onrestored: (taskId: string, focus: boolean) => Promise<void>) {
    return {
      slug: 'aoba',
      workspaceId: 'w1',
      taskId: 't1',
      title: '題',
      near: null,
      onchanged: vi.fn(),
      onstale: vi.fn(),
      onrestored,
      onskipped: undefined,
    };
  }

  test('戻せた後の読み直し（onrestored）が失敗しても reject せず、失敗を文で知らせる', async () => {
    mocks.callOperation.mockResolvedValue({ ok: true, data: { cleared: [] } });
    const onrestored = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(restoreRemoved(target(onrestored), true)).resolves.toBeUndefined();
    expect(onrestored).toHaveBeenCalledWith('t1', true);
    expect(toastMessages()).toEqual(['taskRestored', 'taskListReloadFailed']);
  });

  test('理由の無い 409 は onchanged だけで、onrestored は呼ばない', async () => {
    mocks.callOperation.mockResolvedValue(failure(409, 'conflict'));
    const onrestored = vi.fn(async () => {});
    const t1 = target(onrestored);
    await expect(restoreRemoved(t1)).resolves.toBeUndefined();
    expect(t1.onchanged).toHaveBeenCalledTimes(1);
    expect(onrestored).not.toHaveBeenCalled();
  });

  test('409 の not_deleted（もう戻っている）は、戻せたのと同じに扱い、読み直しの失敗は投げない', async () => {
    mocks.callOperation.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: 'conflict', message: '', details: { reason: 'not_deleted' } },
    });
    const onrestored = vi.fn(async () => {
      throw new Error('network');
    });
    const t1 = target(onrestored);
    await expect(restoreRemoved(t1, true)).resolves.toBeUndefined();
    expect(onrestored).toHaveBeenCalledWith('t1', true);
    expect(t1.onchanged).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual(['taskRestored', 'taskListReloadFailed']);
  });
});
