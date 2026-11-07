// ⌘（Windows と Linux は Ctrl）を約 0.3 秒押し続けた間だけ、ショートカットのあるものの角にキーを出す状態。
// 出す対象は登録（shortcuts.svelte.ts の items）から引く。今押せば働くもの（isAvailable）で、hintAnchor の要素が見えているものだけ。
// 見た目だけで、押したキーも動作も変えない（読み上げは aria-keyshortcuts が伝える）。
// ほかのキーが押されたら出さず、離す、ウィンドウを離れる、スクロールする、ポインターを押すと消す。タッチの端末では出さない。
import { hintText, isMacPlatform } from './shortcut-keys.ts';
import { shortcuts as sharedShortcuts, type ShortcutRegistry } from './shortcuts.svelte.ts';

export interface ShortcutHint {
  id: string;
  text: string;
  // 画面の左上からの位置（px）。角をまたいで出すので、キーの右端と上端の座標を渡す（CSS が右端を合わせる）
  right: number;
  top: number;
}

const HINT_DELAY_MS = 300;
// キーの幅の見積もり（1文字あたりと余白）。左端で切れないよう内側に寄せるのに使う
const CHAR_WIDTH = 8;
const PADDING_WIDTH = 16;
const EDGE = 4;

interface Options {
  registry?: ShortcutRegistry;
  mac?: boolean;
  // 指の端末（hover: none）か
  isTouch?: () => boolean;
  // キー入力の先（文字を打つ場所では、修飾キー付きでないものを出さない）
  target?: () => EventTarget | null;
}

type ModEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;

export class ShortcutHints {
  hints = $state.raw<ShortcutHint[]>([]);
  #timer: ReturnType<typeof setTimeout> | null = null;
  // 修飾キーだけを押し続けている間（別のキー、離す、ウィンドウを離れるで外れる）。スクロールなどで消えても、押し続ければ出し直す
  #armed = false;
  #registry: ShortcutRegistry;
  #mac: boolean;
  #isTouch: () => boolean;
  #target: () => EventTarget | null;

  constructor(options: Options = {}) {
    this.#registry = options.registry ?? sharedShortcuts;
    this.#mac = options.mac ?? isMacPlatform();
    this.#isTouch = options.isTouch ?? (() => globalThis.matchMedia?.('(hover: none)').matches ?? false);
    this.#target = options.target ?? (() => globalThis.document?.activeElement ?? null);
  }

  get #modKey(): string {
    return this.#mac ? 'Meta' : 'Control';
  }

  keydown = (event: ModEvent): void => {
    // ほかのキー（⌘C など）が押されたら、待っていた分も出ているものも取り消し、離すまで出し直さない
    if (event.key !== this.#modKey) {
      this.cancel();
      return;
    }
    // 反対側の修飾キー、Alt、Shift が一緒のときは出さない
    if (event.altKey || event.shiftKey || (this.#mac ? event.ctrlKey : event.metaKey)) return;
    // 押しっぱなしの繰り返しは、待ちを延ばさない
    if (!event.repeat) this.#armed = true;
    if (!this.#armed || this.#timer !== null || this.hints.length > 0) return;
    this.#wait();
  };

  #wait(): void {
    this.#timer = setTimeout(() => this.#show(), HINT_DELAY_MS);
  }

  keyup = (event: Pick<KeyboardEvent, 'key'>): void => {
    if (event.key === this.#modKey) this.cancel();
  };

  // 押している状態を終える（別のキー、離す、ウィンドウやタブを離れる）。待ちも出ているものも消す
  cancel = (): void => {
    this.#armed = false;
    this.dismiss();
  };

  // 今のヒントだけを消す（スクロール、リサイズ、ポインター、ダイアログ）。押し続けていれば、約0.3秒後にまた出す。
  // 修飾キーの keydown の繰り返しが届かない環境（Mac の ⌘ など）でも出し直せるよう、ここで待ちを張り直す。続けて呼ばれたら（スクロール中）待ちを延ばす
  dismiss = (): void => {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.hints.length > 0) this.hints = [];
    if (this.#armed) this.#wait();
  };

  #show(): void {
    this.#timer = null;
    if (this.#isTouch() || globalThis.document?.hidden) return;
    const target = this.#target();
    const shown: ShortcutHint[] = [];
    const anchors: HTMLElement[] = [];
    for (const shortcut of this.#registry.items) {
      const anchor = shortcut.hintAnchor?.();
      if (!anchor || anchors.includes(anchor) || anchor.getAttribute('aria-disabled') === 'true') continue;
      if (!this.#registry.isAvailable(shortcut, target)) continue;
      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > globalThis.innerHeight) continue;
      if (rect.right < 0 || rect.left > globalThis.innerWidth) continue;
      anchors.push(anchor);
      const text = hintText(shortcut.keys, this.#mac);
      const width = text.length * CHAR_WIDTH + PADDING_WIDTH;
      shown.push({
        id: shortcut.id,
        text,
        // 右端は画面の内側へ、左は幅の分だけ内側へ寄せる。上は伸びる分（約22px）の余白を取る
        right: Math.max(Math.min(rect.right + 6, globalThis.innerWidth - EDGE), width + EDGE),
        top: Math.max(rect.top, 22),
      });
    }
    this.hints = shown;
  }
}
