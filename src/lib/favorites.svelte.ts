import { getContext, setContext, untrack } from 'svelte';
import type { OutputOf } from '../shared/operations/define.ts';
import { favoriteList, favoriteSet } from '../shared/operations/favorite.ts';
import { callOperation } from './api.ts';
import { onOperationWrite } from './operation-events.ts';

export type Favorite = OutputOf<typeof favoriteList>['favorites'][number];
export type FavoriteTarget = Pick<Favorite, 'target_type' | 'target_id' | 'workspace_id' | 'title'> & {
  menuVisible?: boolean;
};
const changedTargets = new Set([
  'task-update',
  'task-delete',
  'task-restore',
  'task-move',
  'story-update',
  'story-delete',
  'story-move',
  'epic-update',
  'epic-delete',
  'epic-move',
  'workspace-wiki-update',
  'workspace-wiki-delete',
  'org-wiki-update',
  'org-wiki-delete',
  'workspace-close',
  'workspace-reopen',
  'membership-leave',
  'membership-role-update',
  'user-admin-update',
  'user-disable',
  'user-enable',
]);
const key = Symbol('favorites');
type Source = {
  scope: string;
  slug: string;
  items: Favorite[];
  marks?: Pick<Favorite, 'target_type' | 'target_id'>[];
  available: boolean;
  requestedAt?: number;
};
export class Favorites {
  // raw は、load が返した配列の同一性をプロキシ化で変えないため。
  private changes = $state.raw<
    { source: Source['items']; scope: string; target: FavoriteTarget; marked: boolean; completedAt: number }[]
  >([]);
  private pending = $state<string[]>([]);
  private cached = $state.raw<Source | null>(null);
  private request = 0;
  private refreshState = $state.raw<{ scope: string; loading: boolean; failed: boolean } | null>(null);
  constructor(private source: () => Source) {}
  private currentSource(): Source {
    const source = this.source();
    const cached = this.cached;
    return cached?.scope === source.scope &&
      (!source.available || (cached.requestedAt ?? 0) >= (source.requestedAt ?? 0))
      ? cached
      : source;
  }
  // layout の成功を覚える。一時失敗では直前の一覧を捨てない。
  sync(): void {
    const source = this.source();
    const cached = untrack(() => this.cached);
    if (source.available && (cached?.scope !== source.scope || (source.requestedAt ?? 0) > (cached.requestedAt ?? 0)))
      this.cached = source;
  }
  watch(): () => void {
    this.sync();
    return onOperationWrite((event) => {
      if (event.slug === this.source().slug && changedTargets.has(event.name)) void this.refresh();
    });
  }
  get loading() {
    return this.refreshState?.scope === this.source().scope && this.refreshState.loading;
  }
  get loadFailed() {
    return this.refreshState?.scope === this.source().scope
      ? this.refreshState.failed
      : !this.currentSource().available;
  }
  async refresh(): Promise<void> {
    const source = this.source();
    const request = ++this.request;
    const requestedAt = performance.now();
    this.refreshState = { scope: source.scope, loading: true, failed: false };
    try {
      const result = await callOperation(favoriteList, {}, { slug: source.slug });
      if (request !== this.request || this.source().scope !== source.scope) return;
      if (result.ok) {
        this.cached = {
          ...source,
          items: result.data.favorites,
          marks: result.data.marks,
          available: true,
          requestedAt,
        };
      }
      this.refreshState = { scope: source.scope, loading: false, failed: !result.ok };
    } catch {
      if (request === this.request && this.source().scope === source.scope)
        this.refreshState = { scope: source.scope, loading: false, failed: true };
    }
  }
  // 後から届いた一覧でも、読み取り開始が保存成功より前なら新しい本人の操作を保つ。
  private applies(change: (typeof this.changes)[number], source: Source): boolean {
    return (
      change.scope === source.scope &&
      (change.source === source.items || (source.requestedAt !== undefined && source.requestedAt <= change.completedAt))
    );
  }
  get available() {
    return this.currentSource().available;
  }
  private get allItems(): (Favorite & { menuVisible?: boolean })[] {
    const source = this.currentSource();
    let items: (Favorite & { menuVisible?: boolean })[] = source.items;
    for (const change of this.changes) {
      if (!this.applies(change, source)) continue;
      items = items.filter(
        (item) => item.target_type !== change.target.target_type || item.target_id !== change.target.target_id,
      );
      if (change.marked) items = [{ ...change.target, id: change.target.target_id, created_at: '' }, ...items];
    }
    return items;
  }
  get items() {
    return this.allItems.filter((item) => item.menuVisible !== false);
  }
  marked(type: Favorite['target_type'], id: string) {
    const source = this.currentSource();
    const change = this.changes.findLast(
      (change) => this.applies(change, source) && change.target.target_type === type && change.target.target_id === id,
    );
    return (
      change?.marked ??
      (source.marks ?? source.items).some((item) => item.target_type === type && item.target_id === id)
    );
  }
  busy(type: Favorite['target_type'], id: string) {
    return this.pending.includes(`${this.source().scope}/${type}/${id}`);
  }
  async toggle(target: FavoriteTarget) {
    const source = this.currentSource();
    const token = `${source.scope}/${target.target_type}/${target.target_id}`;
    if (!source.available || this.pending.includes(token)) return null;
    const marked = !this.marked(target.target_type, target.target_id);
    this.pending = [...this.pending, token];
    try {
      const result = await callOperation(
        favoriteSet,
        { target_type: target.target_type, target_id: target.target_id, is_favorite: marked },
        { slug: source.slug },
      );
      if (result.ok && this.source().scope === source.scope) {
        const current = this.currentSource();
        this.changes = [
          ...this.changes.filter(
            (change) =>
              change.scope === source.scope &&
              (change.target.target_type !== target.target_type || change.target.target_id !== target.target_id),
          ),
          {
            source: current.items,
            scope: source.scope,
            target,
            marked: result.data.is_favorite,
            completedAt: performance.now(),
          },
        ];
      }
      return result;
    } finally {
      this.pending = this.pending.filter((item) => item !== token);
    }
  }
}
export function provideFavorites(source: () => Source) {
  return setContext(key, new Favorites(source));
}
export function useFavorites(): Favorites | undefined {
  return getContext(key);
}
