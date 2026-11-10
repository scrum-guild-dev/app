import { taskAssign, taskDetail, taskUpdate, type TaskDetail } from '../shared/operations/task/index.ts';
import { memberList } from '../shared/operations/workspace/index.ts';
import { callOperation, type ApiResult } from './api.ts';
import { showToast } from './toast.svelte.ts';
import { t } from './vocabulary.svelte.ts';

export type Attribute = 'points' | 'assignee' | 'due_on' | 'repository' | 'category';
export type AttributeSaved = {
  slug: string;
  workspaceId: string;
  taskId: string;
  field: Attribute;
  task: TaskDetail;
  at: number;
};
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 購読者の集合は表示の依存にしない
const savedListeners = new Set<(saved: AttributeSaved) => void>();
export function onTaskAttributeSaved(listener: (saved: AttributeSaved) => void): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}
export function publishTaskAttribute(saved: AttributeSaved): void {
  for (const listener of savedListeners) {
    try {
      listener(saved);
    } catch {
      /* 保存の結果と、表示の更新の失敗を分ける */
    }
  }
}

// 値の確定と送信の順序を、表示や保存後の処理から独立させる。
export class AttributeQueue<T> {
  value = $state<T>() as T;
  pending = $state<{ value: T } | null>(null);
  error = $state<string | null>(null);
  sending = $state(false);
  private readAt = -Infinity;
  private savedAt = -Infinity;
  private initialized = false;
  constructor(
    private readonly send: (value: T) => Promise<{ value: T; after: () => Promise<void> | void } | string>,
    private readonly idle: () => void = () => {},
  ) {}
  get shown(): T {
    return this.pending === null ? this.value : this.pending.value;
  }
  observe(value: T, at: number): void {
    if (!this.initialized || (at > this.savedAt && at >= this.readAt)) {
      this.value = value;
      this.readAt = at;
      this.initialized = true;
    }
  }
  choose(value: T): void {
    this.pending = { value };
    this.error = null;
    if (!this.sending) void this.drain();
  }
  private async drain(): Promise<void> {
    this.sending = true;
    try {
      while (this.pending !== null) {
        const choice = this.pending.value;
        if (choice === this.value) {
          this.pending = null;
          continue;
        }
        this.error = null;
        const result = await this.send(choice);
        if (typeof result === 'string') this.error = result;
        else {
          this.value = result.value;
          this.savedAt = performance.now();
        }
        if (this.pending?.value === choice) this.pending = null;
        if (typeof result !== 'string') {
          try {
            await result.after();
          } catch {
            /* 次の選択の送信は続ける */
          }
        }
      }
    } finally {
      this.sending = false;
      this.idle();
    }
  }
}

type Observer = {
  inlineErrors?: boolean;
  rejected?: (message: string) => Promise<void> | void;
  saved?: (saved: AttributeSaved) => Promise<void> | void;
  stale: () => void;
};
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 行の作り直しで送信列を引くレジストリ。描画を起こさない
const sessions = new Map<string, TaskAttributes>();
export function taskAttributes(slug: string, workspaceId: string, taskId: string): TaskAttributes {
  const key = JSON.stringify([slug, workspaceId, taskId]);
  let session = sessions.get(key);
  if (session === undefined) {
    session = new TaskAttributes(slug, workspaceId, taskId, () => {
      if (sessions.get(key) === session) sessions.delete(key);
    });
    sessions.set(key, session);
  }
  return session;
}

export class TaskAttributes {
  readonly points: AttributeQueue<TaskDetail['points']>;
  readonly assignee: AttributeQueue<string>;
  candidates = $state<readonly { id: string; name: string }[] | null>(null);
  candidatesFailed = $state(false);
  candidatesLoading = $state(false);
  private candidatesVersion = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 取り外しは送信の状態や表示を再計算しない
  private observers = new Set<Observer>();
  private stopped = false;
  private stoppedAt = -Infinity;
  private stoppedMessage = '';
  constructor(
    readonly slug: string,
    readonly workspaceId: string,
    readonly taskId: string,
    private readonly dispose: () => void,
  ) {
    this.points = new AttributeQueue(
      (value) => this.send('points', value),
      () => this.cleanup(),
    );
    this.assignee = new AttributeQueue(
      (value) => this.send('assignee', value),
      () => this.cleanup(),
    );
  }
  attach(observer: Observer): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
      this.cleanup();
    };
  }
  private cleanup(): void {
    // 親の移動で同じ描画中に置き直される行には、同じ送信列を渡す。
    queueMicrotask(() => {
      if (this.observers.size === 0 && !this.points.sending && !this.assignee.sending) this.dispose();
    });
  }
  observe(task: { points: TaskDetail['points']; assignee: { id: string } | null }, at: number): void {
    if (at > this.stoppedAt) this.stopped = false;
    this.points.observe(task.points, at);
    this.assignee.observe(task.assignee?.id ?? '', at);
  }
  async loadCandidates(): Promise<void> {
    const version = ++this.candidatesVersion;
    this.candidatesLoading = true;
    const result = await callOperation(memberList, { workspace_id: this.workspaceId }, { slug: this.slug });
    if (version !== this.candidatesVersion) return;
    this.candidatesLoading = false;
    this.candidatesFailed = !result.ok;
    this.candidates = result.ok ? result.data.members.map(({ id, name }) => ({ id, name })) : null;
  }
  private stop(message: string): string {
    this.stopped = true;
    this.stoppedAt = performance.now();
    this.stoppedMessage = message;
    this.points.pending = null;
    this.assignee.pending = null;
    return message;
  }
  async explain(
    result: Exclude<ApiResult<unknown>, { ok: true }>,
    doneReason: string,
    missingAssignee = false,
  ): Promise<string> {
    if (result.status === 401 || (result.status === 409 && result.error?.code === 'workspace_closed')) {
      for (const observer of this.observers) {
        try {
          observer.stale();
        } catch {
          /* 失敗の通知と後始末を続ける */
        }
      }
      if (result.status === 409) {
        return this.stop(t('workspaceClosedReadOnly', { workspace: t('workspace') }));
      }
    }
    if (result.status === 409 || result.status === 404) {
      const latest = await callOperation(
        taskDetail,
        { workspace_id: this.workspaceId, task_id: this.taskId },
        { slug: this.slug },
      );
      if (!latest.ok) {
        return latest.status === 404 ? this.stop(t('taskGone', { task: t('task') })) : t('taskSaveFailed');
      }
      if (latest.data.task.completed_at !== null) {
        return this.stop(doneReason);
      }
      if (result.status === 404) {
        if (!missingAssignee) return t('taskSaveFailed');
        void this.loadCandidates();
        return t('assigneeNotMember', { workspace: t('workspace'), assignee: t('assignee') });
      }
      return t('taskSaveRaced');
    }
    return result.status === 400 ? t('taskBadRequest') : t('taskSaveFailed');
  }
  private async reject(message: string): Promise<void> {
    const inline = () => [...this.observers].some((observer) => observer.inlineErrors);
    const notified = message === t('taskGone', { task: t('task') }) || !inline();
    if (notified) showToast(message, 'alert');
    for (const observer of this.observers) {
      try {
        await observer.rejected?.(message);
      } catch {
        /* 保存の失敗を別の失敗で隠さない */
      }
    }
    if (!notified && !inline()) showToast(message, 'alert');
  }
  private async send<K extends 'points' | 'assignee'>(
    field: K,
    value: K extends 'points' ? TaskDetail['points'] : string,
  ): Promise<{ value: typeof value; after: () => Promise<void> } | string> {
    if (this.stopped) {
      await this.reject(this.stoppedMessage);
      return this.stoppedMessage;
    }
    const input = { workspace_id: this.workspaceId, task_id: this.taskId };
    const result =
      field === 'points'
        ? await callOperation(taskUpdate, { ...input, points: value as TaskDetail['points'] }, { slug: this.slug })
        : await callOperation(
            taskAssign,
            { ...input, assignee_user_id: value === '' ? null : (value as string) },
            { slug: this.slug },
          );
    if (!result.ok) {
      const message = await this.explain(
        result,
        field === 'points'
          ? t('taskSaveConflict', { task: t('task'), done: t('done'), points: t('points') })
          : t('taskAssigneeDone', { task: t('task'), done: t('done'), assignee: t('assignee') }),
        field === 'assignee',
      );
      await this.reject(message);
      return message;
    }
    const saved: AttributeSaved = {
      slug: this.slug,
      workspaceId: this.workspaceId,
      taskId: this.taskId,
      field,
      task: result.data.task,
      at: performance.now(),
    };
    return {
      value: (field === 'points' ? result.data.task.points : (result.data.task.assignee?.id ?? '')) as typeof value,
      after: async () => {
        publishTaskAttribute(saved);
        showToast(t('taskSaved'), 'check');
        for (const observer of this.observers) {
          try {
            await observer.saved?.(saved);
          } catch {
            /* ほかの表示と次の送信を妨げない */
          }
        }
      },
    };
  }
}
