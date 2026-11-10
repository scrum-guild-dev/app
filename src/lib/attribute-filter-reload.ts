import type { BacklogFilter } from './backlog-filter.ts';
import { completionSettled } from './added-rows.ts';
import type { Attribute } from './task-attributes.svelte.ts';

export function attributeAffectsFilter(field: Attribute, filter: BacklogFilter): boolean {
  return (field === 'assignee' || field === 'category' || field === 'repository') && filter[field] !== '';
}

export function completedAfterAttributeRead(
  ids: readonly string[],
  at: Readonly<Record<string, number>>,
  loadedAt: number,
  preserve: boolean,
): string[] {
  return ids.filter((id) => preserve || !completionSettled(at[id] ?? Infinity, loadedAt));
}

// 属性が絞り込みを変える場合だけ、移動を待って再取得する。読み取り中の別の保存は最後にもう一度反映する。
export class FilteredAttributeReload {
  preservesState = false;
  private running: Promise<void> | null = null;
  private requested: (() => boolean) | null = null;
  constructor(
    private readonly hooks: {
      whenIdle: () => Promise<void>;
      reload: () => Promise<void>;
      failed?: (error: unknown) => void;
    },
  ) {}
  request(isCurrent: () => boolean = () => true): Promise<void> {
    this.requested = isCurrent;
    this.running ??= Promise.resolve().then(() => this.drain());
    return this.running;
  }
  private async drain(): Promise<void> {
    let failure: { error: unknown; current: () => boolean } | undefined;
    try {
      while (this.requested !== null) {
        const current = this.requested;
        this.requested = null;
        let waiting: Promise<void>;
        do {
          waiting = this.hooks.whenIdle();
          await waiting;
        } while (waiting !== this.hooks.whenIdle());
        if (!current()) continue;
        this.preservesState = true;
        try {
          await this.hooks.reload();
          failure = undefined;
        } catch (error) {
          failure = { error, current };
        } finally {
          this.preservesState = false;
        }
      }
      if (failure !== undefined) {
        if (failure.current()) this.hooks.failed?.(failure.error);
        throw failure.error;
      }
    } finally {
      this.running = null;
    }
  }
}
