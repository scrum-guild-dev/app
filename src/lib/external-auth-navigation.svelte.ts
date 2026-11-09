// 外への遷移は失敗や Esc で中断しても通知されない。一定時間後には押し直せるようにする。
export const EXTERNAL_AUTH_RETRY_MS = 10_000;

type Provider = 'github' | 'google';

export class ExternalAuthNavigation {
  moving = $state<Provider | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  start(event: MouseEvent, provider: Provider): void {
    if (this.moving) {
      event.preventDefault();
      return;
    }
    // 別のタブやウィンドウで開くときは、この画面を待機中にしない。
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    this.moving = provider;
    this.timer = setTimeout(() => this.reset(), EXTERNAL_AUTH_RETRY_MS);
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.moving = null;
  }
}
