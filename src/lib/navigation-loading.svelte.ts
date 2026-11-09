type Target = { route: { id: string | null }; url: URL };
export type LoadingKind = 'outside' | 'inside' | null;

export function navigationLoadingKind(from: Target | null, to: Target | null): LoadingKind {
  if (!to) return null;
  if (!from?.route.id?.startsWith('/[slug]')) return 'outside';
  return to.route.id?.startsWith('/[slug]') && from.url.pathname !== to.url.pathname ? 'inside' : null;
}

// root が1つのタイマーを管理し、本文と読み上げが同じ状態を見る。
export class NavigationLoading {
  kind = $state<LoadingKind>(null);

  begin(kind: LoadingKind): () => void {
    this.kind = null;
    const timer = kind === null ? undefined : setTimeout(() => (this.kind = kind), 300);
    return () => {
      clearTimeout(timer);
      this.kind = null;
    };
  }
}

export const navigationLoading = new NavigationLoading();
