// ⌘（Windows と Linux は Ctrl）を約 0.3 秒押し続けた間だけ、ショートカットのあるものの角にキーを出す状態。
// 出す対象は登録（shortcuts.svelte.ts の items）から引く。今押せば働くもの（isAvailable）で、hintAnchor の要素が見えているものだけ。
// 見た目だけで、押したキーも動作も変えない（読み上げは aria-keyshortcuts が伝える）。
// ほかのキーが押されたら出さず、離す、ウィンドウを離れる、スクロールする、ポインターを押すと消す。タッチの端末では出さない。
import { hintText, isMacPlatform } from './shortcut-keys.ts';
import { shortcuts as sharedShortcuts, type ShortcutRegistry } from './shortcuts.svelte.ts';

export interface ShortcutHint {
  id: string;
  text: string;
  // 画面の左上からの位置（px）。角をまたいで出すので、右端と上端の座標を渡す
  left: number;
  top: number;
}

export const HINT_DELAY_MS = 300;

interface Options {
  registry?: ShortcutRegistry;
  mac?: boolean;
  delay?: number;
  // 指の端末（hover: none）か
  isTouch?: () => boolean;
  // キー入力の先（文字を打つ場所では、修飾キー付きでないものを出さない）
  target?: () => EventTarget | null;
}

type ModEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;

export class ShortcutHints {
  hints = $state.raw<ShortcutHint[]>([]);
  #timer: ReturnType<typeof setTimeout> | null = null;
  #registry: ShortcutRegistry;
  #mac: boolean;
  #delay: number;
  #isTouch: () => boolean;
  #target: () => EventTarget | null;

  constructor(options: Options = {}) {
    this.#registry = options.registry ?? sharedShortcuts;
    this.#mac = options.mac ?? isMacPlatform();
    this.#delay = options.delay ?? HINT_DELAY_MS;
    this.#isTouch = options.isTouch ?? (() => globalThis.matchMedia?.('(hover: none)').matches ?? false);
    this.#target = options.target ?? (() => globalThis.document?.activeElement ?? null);
  }

  get #modKey(): string {
    return this.#mac ? 'Meta' : 'Control';
  }

  keydown = (event: ModEvent): void => {
    // ほかのキー（⌘C など）が押されたら、待っていた分も出ているものも取り消す
    if (event.key !== this.#modKey) {
      this.cancel();
      return;
    }
    if (event.repeat || this.#timer !== null || this.hints.length > 0) return;
    // 反対側の修飾キー、Alt、Shift が一緒のときは出さない
    if (event.altKey || event.shiftKey || (this.#mac ? event.ctrlKey : event.metaKey)) return;
    this.#timer = setTimeout(() => this.#show(), this.#delay);
  };

  keyup = (event: Pick<KeyboardEvent, 'key'>): void => {
    if (event.key === this.#modKey) this.cancel();
  };

  cancel = (): void => {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.hints.length > 0) this.hints = [];
  };

  #show(): void {
    this.#timer = null;
    if (this.#isTouch()) return;
    const target = this.#target();
    const shown: ShortcutHint[] = [];
    const anchors: HTMLElement[] = [];
    for (const shortcut of this.#registry.items) {
      const anchor = shortcut.hintAnchor?.();
      if (!anchor || anchors.includes(anchor) || anchor.getAttribute('aria-disabled') === 'true') continue;
      if (!this.#registry.isAvailable(shortcut, target)) continue;
      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > globalThis.innerHeight) continue;
      anchors.push(anchor);
      shown.push({
        id: shortcut.id,
        text: hintText(shortcut.keys, this.#mac),
        left: Math.min(rect.right + 6, globalThis.innerWidth - 4),
        top: Math.max(rect.top, 16),
      });
    }
    this.hints = shown;
  }
}
