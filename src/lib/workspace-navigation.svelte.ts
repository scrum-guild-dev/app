import type { WorkspaceView } from './workspace.ts';

export type NavigationWorkspace = Pick<WorkspaceView, 'id' | 'name' | 'role'>;
type Membership = NavigationWorkspace & { role: 'leader' | 'member' };

// 組織の枠のインスタンス内だけで覚える。scope は組織の slug と本人の ID。
// 画面の現在地とは別の、メニューのリンク先。名前とロールは毎回、今の所属一覧から取る。
export class WorkspaceNavigation {
  private known = $state<{ scope: string; id: string } | null>(null);

  private member(scope: string, workspaces: readonly Membership[], opened: NavigationWorkspace | null) {
    return (
      workspaces.find((workspace) => workspace.id === opened?.id) ??
      workspaces.find((workspace) => this.known?.scope === scope && workspace.id === this.known.id) ??
      workspaces[0] ??
      null
    );
  }

  select(
    scope: string,
    workspaces: readonly Membership[],
    opened: NavigationWorkspace | null,
  ): NavigationWorkspace | null {
    // 所属していない管理者が開いている画面は、従来どおりそのワークスペースを指す。
    return opened ?? this.member(scope, workspaces, opened);
  }

  remember(scope: string, workspaces: readonly Membership[], opened: NavigationWorkspace | null): void {
    const member = this.member(scope, workspaces, opened);
    if (member) {
      if (this.known?.scope !== scope || this.known.id !== member.id) this.known = { scope, id: member.id };
    } else if (this.known) {
      this.known = null;
    }
  }
}
