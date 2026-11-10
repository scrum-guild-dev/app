import { beforeEach, expect, test, vi } from 'vitest';
import { AttributeQueue, taskAttributes, onTaskAttributeSaved } from './task-attributes.svelte.ts';
import type { TaskDetail } from '../shared/operations/task/index.ts';

const mocks = vi.hoisted(() => ({ call: vi.fn(), toast: vi.fn(), t: vi.fn((key: string) => key) }));
vi.mock('./api.ts', () => ({ callOperation: mocks.call }));
vi.mock('./toast.svelte.ts', () => ({ showToast: mocks.toast }));
vi.mock('./vocabulary.svelte.ts', () => ({ t: mocks.t }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const detail = (patch: Partial<TaskDetail> = {}): TaskDetail => ({
  id: 'task',
  title: '架空の仕事',
  body_md: null,
  points: null,
  due_on: null,
  link_url: null,
  assignee: null,
  delegatee: null,
  is_imported: false,
  completed_at: null,
  reopenable: false,
  can_delete: true,
  thanks: [],
  can_send_thanks: false,
  story_id: null,
  category: null,
  repository: null,
  sprint: null,
  ...patch,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.t.mockImplementation((key: string) => key);
});

test.each([null, ''] as const)('送信中に最後の選択を元の値 %s に戻しても、その値を送り直す', async (base) => {
  const held = gate<void>();
  const sent: (string | number | null)[] = [];
  const queue = new AttributeQueue<string | number | null>(async (value) => {
    sent.push(value);
    if (sent.length === 1) await held.promise;
    return { value, after: () => {} };
  });
  queue.observe(base, 0);
  queue.choose(5);
  queue.choose(8);
  queue.choose(base);
  expect(sent).toEqual([5]);
  held.resolve();
  await settle();
  expect(sent).toEqual([5, base]);
  expect(queue.shown).toBe(base);
});

test('保存後の更新が投げても、確定値と表示を保ち次の選択を送れる', async () => {
  const after = gate<void>();
  const sent: (number | null)[] = [];
  const queue = new AttributeQueue<number | null>(async (value) => {
    sent.push(value);
    return {
      value,
      after: async () => {
        await after.promise;
        throw new Error('表示の更新失敗');
      },
    };
  });
  queue.observe(null, 0);
  queue.choose(5);
  await settle();
  queue.observe(null, 0);
  expect(queue.shown).toBe(5);
  queue.choose(null);
  after.resolve();
  await settle();
  expect(sent).toEqual([5, null]);
  expect(queue.shown).toBeNull();
  expect(queue.sending).toBe(false);
});

test('保存前に始まった読み取りでは戻さず、保存後の新しい読み取りを受け入れる', async () => {
  const queue = new AttributeQueue<number | null>(async (value) => ({ value, after: () => {} }));
  const oldRead = performance.now();
  queue.observe(null, oldRead);
  queue.choose(5);
  await settle();
  queue.observe(null, oldRead);
  expect(queue.shown).toBe(5);
  queue.observe(8, performance.now() + 1);
  expect(queue.shown).toBe(8);
});

test('失敗しても送信中に選び直した最後の値は捨てない', async () => {
  const held = gate<void>();
  const send = vi.fn(async (value: number) => {
    if (send.mock.calls.length === 1) {
      await held.promise;
      return '通信失敗';
    }
    return { value, after: () => {} };
  });
  const queue = new AttributeQueue(send);
  queue.observe(0, 0);
  queue.choose(5);
  queue.choose(8);
  held.resolve();
  await settle();
  expect(send.mock.calls.map(([value]) => value)).toEqual([5, 8]);
  expect(queue.shown).toBe(8);
  expect(queue.error).toBeNull();
});

test('親の移動で旧行が外れ、新しい行や引き出しが選んでも、同じタスクの要求は並走しない', async () => {
  const held = gate<unknown>();
  mocks.call
    .mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce({ ok: true, data: { task: detail({ points: 8 }) } });
  const oldRow = taskAttributes('aoba', 'w', 'remount');
  const detach = oldRow.attach({ stale: vi.fn() });
  oldRow.observe(detail(), 0);
  oldRow.points.choose(5);
  detach();
  await settle();
  const newRow = taskAttributes('aoba', 'w', 'remount');
  const release = newRow.attach({ stale: vi.fn() });
  expect(newRow).toBe(oldRow);
  newRow.points.choose(8);
  expect(mocks.call).toHaveBeenCalledTimes(1);
  held.resolve({ ok: true, data: { task: detail({ points: 5 }) } });
  await settle();
  expect(mocks.call.mock.calls.map(([, input]) => input.points)).toEqual([5, 8]);
  expect(newRow.points.shown).toBe(8);
  release();
  await settle();
  expect(taskAttributes('aoba', 'w', 'remount')).not.toBe(oldRow);
});

test('行が外れた後の失敗もトーストで知らせる', async () => {
  const held = gate<unknown>();
  mocks.call.mockReturnValueOnce(held.promise);
  const editor = taskAttributes('aoba', 'w', 'gone-view');
  const detach = editor.attach({ stale: vi.fn() });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  detach();
  held.resolve({ ok: false, status: 0, error: null });
  await settle();
  expect(mocks.toast).toHaveBeenCalledWith('taskSaveFailed', 'alert');
  expect(editor.points.shown).toBeNull();
});

test.each([
  [404, null, { ok: false, status: 404, error: null }, 'taskGone'],
  [404, null, { ok: true, data: { task: detail() } }, 'assigneeNotMember'],
  [409, { code: 'conflict' }, { ok: true, data: { task: detail({ completed_at: '2026-11-10' }) } }, 'taskAssigneeDone'],
  [409, { code: 'conflict' }, { ok: true, data: { task: detail() } }, 'taskSaveRaced'],
  [409, { code: 'conflict' }, { ok: false, status: 500, error: null }, 'taskSaveFailed'],
] as const)('担当の失敗 %s を現在の状態で説明する: %s', async (status, error, latest, message) => {
  mocks.call
    .mockResolvedValueOnce({ ok: false, status, error })
    .mockResolvedValueOnce(latest)
    .mockResolvedValue({ ok: true, data: { members: [] } });
  const editor = taskAttributes('aoba', 'w', `reason-${message}`);
  const detach = editor.attach({ stale: vi.fn() });
  editor.observe(detail(), 0);
  editor.assignee.choose('member');
  await settle();
  expect(editor.assignee.error).toBe(message);
  expect(mocks.toast).toHaveBeenCalledWith(message, 'alert');
  detach();
});

test('候補の後発だけを反映し、失敗したら古い候補を選ばせない', async () => {
  const old = gate<unknown>();
  mocks.call
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ ok: true, data: { members: [{ id: 'new', name: '架空の人' }] } });
  const editor = taskAttributes('aoba', 'w', 'candidates');
  const detach = editor.attach({ stale: vi.fn() });
  const first = editor.loadCandidates();
  await editor.loadCandidates();
  old.resolve({ ok: true, data: { members: [{ id: 'old', name: '古い人' }] } });
  await first;
  expect(editor.candidates).toEqual([{ id: 'new', name: '架空の人' }]);
  mocks.call.mockResolvedValueOnce({ ok: false, status: 500, error: null });
  await editor.loadCandidates();
  expect(editor.candidates).toBeNull();
  expect(editor.candidatesFailed).toBe(true);
  detach();
});

test('組織とワークスペースを分離し、保存後の通知の例外で次の送信を止めない', async () => {
  const editor = taskAttributes('aoba', 'w', 'isolation');
  expect(taskAttributes('other', 'w', 'isolation')).not.toBe(editor);
  expect(taskAttributes('aoba', 'other', 'isolation')).not.toBe(editor);
  const detach = editor.attach({
    stale: vi.fn(),
    saved: () => {
      throw new Error('onSaved');
    },
  });
  editor.observe(detail(), 0);
  const saved = vi.fn();
  const unlisten = onTaskAttributeSaved(saved);
  mocks.call
    .mockResolvedValueOnce({ ok: true, data: { task: detail({ points: 5 }) } })
    .mockResolvedValueOnce({ ok: true, data: { task: detail() } });
  editor.points.choose(5);
  await settle();
  editor.points.choose(null);
  await settle();
  expect(mocks.call).toHaveBeenCalledTimes(2);
  expect(saved).toHaveBeenCalledTimes(2);
  expect(mocks.toast).toHaveBeenCalledWith('taskSaved', 'check');
  expect(saved.mock.calls[0][0]).toMatchObject({
    slug: 'aoba',
    workspaceId: 'w',
    taskId: 'isolation',
    field: 'points',
  });
  expect(editor.points.shown).toBeNull();
  unlisten();
  detach();
});

test('古い表示の後始末が、同じキーの新しい送信列を消さない', async () => {
  const old = taskAttributes('aoba', 'w', 'late-cleanup');
  const detach = old.attach({ stale: vi.fn() });
  detach();
  await settle();
  const current = taskAttributes('aoba', 'w', 'late-cleanup');
  const release = current.attach({ stale: vi.fn() });
  detach();
  await settle();
  expect(taskAttributes('aoba', 'w', 'late-cleanup')).toBe(current);
  release();
});

test('削除されたタスクの後始末には、既に通知した理由を渡す', async () => {
  mocks.call.mockResolvedValue({ ok: false, status: 404, error: null });
  const editor = taskAttributes('aoba', 'w', 'removed-reason');
  const rejected = vi.fn();
  const detach = editor.attach({ stale: vi.fn(), rejected });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  expect(rejected).toHaveBeenCalledWith('taskGone', 'gone');
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  detach();
});

test('引き出しに失敗を出せる間は同じ文のトーストを重ねない', async () => {
  mocks.call.mockResolvedValue({ ok: false, status: 0, error: null });
  const editor = taskAttributes('aoba', 'w', 'inline-errors');
  const detach = editor.attach({ stale: vi.fn(), inlineErrors: true });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  expect(editor.points.error).toBe('taskSaveFailed');
  expect(mocks.toast).not.toHaveBeenCalled();
  detach();
});

test('失敗の読み直し中に引き出しが閉じたらトーストで知らせる', async () => {
  mocks.call.mockResolvedValue({ ok: false, status: 0, error: null });
  const held = gate<void>();
  const editor = taskAttributes('aoba', 'w', 'inline-detached');
  const detach = editor.attach({ stale: vi.fn(), inlineErrors: true, rejected: () => held.promise });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  detach();
  held.resolve();
  await settle();
  expect(mocks.toast).toHaveBeenCalledWith('taskSaveFailed', 'alert');
  expect(mocks.toast).toHaveBeenCalledTimes(1);
});

test('他の欄から停止した後も無言で捨てず、古い読み取りでは停止を解除しない', async () => {
  const editor = taskAttributes('aoba', 'w', 'stopped-direct');
  const rejected = vi.fn();
  const detach = editor.attach({ stale: vi.fn(), rejected });
  editor.observe(detail(), 0);
  await editor.explain({ ok: false, status: 409, error: { code: 'workspace_closed', message: 'closed' } }, 'done');
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  expect(mocks.call).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith('workspaceClosedReadOnly', 'alert');
  expect(rejected).toHaveBeenCalledWith('workspaceClosedReadOnly', 'closed');
  detach();
});

test.each(['gone', 'completed'] as const)('同じ表示文でも失敗の種別 %s を区別する', async (reason) => {
  mocks.t.mockReturnValue('同じ表示文');
  mocks.call
    .mockResolvedValueOnce({ ok: false, status: 409, error: { code: 'conflict' } })
    .mockResolvedValueOnce(
      reason === 'gone'
        ? { ok: false, status: 404, error: null }
        : { ok: true, data: { task: detail({ completed_at: '2026-11-10' }) } },
    );
  const editor = taskAttributes('aoba', 'w', `reason-type-${reason}`);
  const rejected = vi.fn();
  const detach = editor.attach({ stale: vi.fn(), rejected });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  expect(rejected).toHaveBeenCalledWith('同じ表示文', reason);
  detach();
});

test('引き出しの書きかけがある間は、行の広いstale通知で組織の枠まで読み直さない', async () => {
  mocks.call.mockResolvedValue({ ok: false, status: 409, error: { code: 'workspace_closed' } });
  const editor = taskAttributes('aoba', 'w', 'stale-scope');
  const rowStale = vi.fn();
  const drawerStale = vi.fn();
  const detachRow = editor.attach({ stale: rowStale });
  const detachDrawer = editor.attach({ stale: drawerStale, inlineErrors: true });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  expect(drawerStale).toHaveBeenCalledTimes(1);
  expect(rowStale).not.toHaveBeenCalled();
  expect(editor.points.error).toBe('workspaceClosedReadOnly');
  detachRow();
  detachDrawer();
});

test('ポイントで完了に気づいた後の担当操作には、担当の失敗文を出す', async () => {
  mocks.call
    .mockResolvedValueOnce({ ok: false, status: 409, error: { code: 'conflict' } })
    .mockResolvedValueOnce({ ok: true, data: { task: detail({ completed_at: '2026-11-10' }) } });
  const editor = taskAttributes('aoba', 'w', 'stopped-field-reason');
  const detach = editor.attach({ stale: vi.fn() });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  editor.assignee.choose('member');
  await settle();
  expect(mocks.call).toHaveBeenCalledTimes(2);
  expect(editor.assignee.error).toBe('taskAssigneeDone');
  expect(mocks.toast).toHaveBeenLastCalledWith('taskAssigneeDone', 'alert');
  detach();
});

test('行から起こした失敗は、引き出しが開いていてもトーストで知らせる', async () => {
  mocks.call.mockResolvedValue({ ok: false, status: 0, error: null });
  const editor = taskAttributes('aoba', 'w', 'row-with-drawer');
  const detachRow = editor.attach({ stale: vi.fn() });
  const detachDrawer = editor.attach({ stale: vi.fn(), inlineErrors: true });
  editor.observe(detail(), 0);
  editor.points.choose(5, true);
  await settle();
  expect(mocks.toast).toHaveBeenCalledWith('taskSaveFailed', 'alert');
  expect(editor.points.errorViaToast).toBe(true);
  detachRow();
  detachDrawer();
});

test('失敗後の再取得も引き出しを優先し、行の全体再取得を重ねない', async () => {
  mocks.call.mockResolvedValue({ ok: false, status: 409, error: { code: 'workspace_closed' } });
  const editor = taskAttributes('aoba', 'w', 'rejected-scope');
  const rowReload = vi.fn();
  const drawerRefresh = vi.fn();
  const detachRow = editor.attach({ stale: vi.fn(), rejected: rowReload });
  const detachDrawer = editor.attach({ stale: vi.fn(), inlineErrors: true, rejected: drawerRefresh });
  editor.observe(detail(), 0);
  editor.points.choose(5);
  await settle();
  expect(drawerRefresh).toHaveBeenCalledExactlyOnceWith('workspaceClosedReadOnly', 'closed');
  expect(rowReload).not.toHaveBeenCalled();
  expect(editor.points.error).toBe('workspaceClosedReadOnly');
  detachRow();
  detachDrawer();
});
