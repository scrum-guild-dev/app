import { beforeEach, describe, expect, test, vi } from 'vitest';

// 画面に触れる部品（page、トースト、辞書）を差し替え、document は印の有無だけを答える偽物を置く
const mocks = vi.hoisted(() => ({
  page: { data: {} as Record<string, unknown> },
  showToast: vi.fn(),
  noteShown: false,
}));
vi.mock('./toast.svelte.ts', () => ({ showToast: mocks.showToast }));
vi.mock('./vocabulary.svelte.ts', () => ({ t: (key: string) => key }));

import {
  settleListReload,
  listFailedIn,
  clearReloadFailure,
  markReloadFailed,
  reloadFailureMessage,
  reloadFailureNote,
  throwIfListFailed,
} from './task-reload-failure.svelte.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  clearReloadFailure();
  mocks.noteShown = true;
  mocks.page.data = {};
  vi.stubGlobal('document', { querySelector: () => (mocks.noteShown ? {} : null) });
});

describe('markReloadFailed と reloadFailureNote', () => {
  test('印は同じワークスペースにだけ出し、下ろすと消える', async () => {
    markReloadFailed('deleted', 'w1');
    expect(reloadFailureNote('w1')).toBe('taskDeletedReloadFailed');
    expect(reloadFailureNote('w2')).toBeNull();
    await settle();
    expect(mocks.showToast).not.toHaveBeenCalled();
    clearReloadFailure();
    expect(reloadFailureNote('w1')).toBeNull();
  });

  test('先の「削除しましたが」を、断られた後の読み直し（stale）で上書きしない。戻した後（restored）は上書きする', () => {
    markReloadFailed('deleted', 'w1');
    markReloadFailed('stale', 'w1');
    expect(reloadFailureNote('w1')).toBe('taskDeletedReloadFailed');
    markReloadFailed('restored', 'w1');
    expect(reloadFailureNote('w1')).toBe('taskRestoredReloadFailed');
  });

  test('別のワークスペースの stale は上書きする（前のワークスペースの印を持ち越さない）', () => {
    markReloadFailed('deleted', 'w1');
    markReloadFailed('stale', 'w2');
    expect(reloadFailureNote('w1')).toBeNull();
    expect(reloadFailureNote('w2')).toBe('taskListStaleReloadFailed');
  });

  test('印を出す画面が無い（一覧が前のまま残った）ときは、トーストで知らせて印を下ろす', async () => {
    mocks.noteShown = false;
    markReloadFailed('deleted', 'w1');
    await settle();
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith('taskListReloadFailed', 'alert');
    expect(reloadFailureNote('w1')).toBeNull();
  });

  test('文は、消した、戻したことが済んでいると分かる形にする', () => {
    expect(reloadFailureMessage('saved')).toBe('taskSavedReloadFailed');
    expect(reloadFailureMessage('deleted')).toBe('taskDeletedReloadFailed');
    expect(reloadFailureMessage('restored')).toBe('taskRestoredReloadFailed');
    expect(reloadFailureMessage('stale')).toBe('taskListStaleReloadFailed');
  });
});

describe('throwIfListFailed', () => {
  test('今の画面の木かボードが null なら投げ、読めていれば投げない。一覧の無い画面では投げない', async () => {
    mocks.page.data = { tree: null };
    await expect(throwIfListFailed(() => mocks.page.data)).rejects.toThrow();
    mocks.page.data = { board: null };
    await expect(throwIfListFailed(() => mocks.page.data)).rejects.toThrow();
    mocks.page.data = { tree: { tasks: [] } };
    await expect(throwIfListFailed(() => mocks.page.data)).resolves.toBeUndefined();
    mocks.page.data = { board: { columns: [] } };
    await expect(throwIfListFailed(() => mocks.page.data)).resolves.toBeUndefined();
    mocks.page.data = { workspace: {} };
    await expect(throwIfListFailed(() => mocks.page.data)).resolves.toBeUndefined();
  });

  test('読めた（一覧の無い画面を含む）ら印を下ろし、読めなければ印を残す', async () => {
    markReloadFailed('deleted', 'w1');
    mocks.page.data = { tree: null };
    await expect(throwIfListFailed(() => mocks.page.data)).rejects.toThrow();
    expect(reloadFailureNote('w1')).toBe('taskDeletedReloadFailed');
    // 一覧の無い画面（メンバーなど）で「取り消す」を押して戻せた
    mocks.page.data = { members: [] };
    await throwIfListFailed(() => mocks.page.data);
    expect(reloadFailureNote('w1')).toBeNull();
  });

  test('settleListReload は、読めなければ印を付け、読めたら下ろす（引き出しの削除と取り消しの後）', () => {
    settleListReload({ tree: null }, 'deleted', 'w1');
    expect(reloadFailureNote('w1')).toBe('taskDeletedReloadFailed');
    settleListReload({ tree: {} }, 'restored', 'w1');
    expect(reloadFailureNote('w1')).toBeNull();
  });

  test('listFailedIn は木かボードが null のときだけ真', () => {
    expect(listFailedIn({ tree: null })).toBe(true);
    expect(listFailedIn({ board: null })).toBe(true);
    expect(listFailedIn({ tree: {} })).toBe(false);
    expect(listFailedIn({})).toBe(false);
  });
});
