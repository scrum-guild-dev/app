import { callOperation } from './api.ts';
import { invitationList } from '../shared/operations/workspace/index.ts';

// 広い幅と狭い幅のアカウントメニューで、件数と再試行を共有する。
export class InvitationCount {
  #initial: () => Promise<number | null>;
  #read: () => Promise<number | null>;
  #retried = $state.raw<{ initial: Promise<number | null>; promise: Promise<number | null> } | null>(null);
  #settled = $state.raw<{ source: Promise<number | null>; count: number | null } | null>(null);

  constructor(initial: () => Promise<number | null>, slug: () => string, read?: () => Promise<number | null>) {
    this.#initial = initial;
    this.#read =
      read ??
      (() =>
        callOperation(invitationList, {}, { slug: slug() }).then((result) =>
          result.ok ? result.data.invitations.length : null,
        ));
    $effect(() => {
      const source = this.#current();
      let active = true;
      void source.then((count) => {
        if (active) this.#settled = { source, count };
      });
      return () => {
        active = false;
      };
    });
  }

  #current(): Promise<number | null> {
    const initial = this.#initial();
    return this.#retried?.initial === initial ? this.#retried.promise : initial;
  }

  get loading(): boolean {
    return this.#settled?.source !== this.#current();
  }
  get count(): number | null {
    return this.loading ? null : (this.#settled?.count ?? null);
  }
  get retrying(): boolean {
    return this.loading && this.#retried?.initial === this.#initial();
  }

  retry(): void {
    if (this.loading || this.count !== null) return;
    this.#retried = { initial: this.#initial(), promise: this.#read() };
  }
}
