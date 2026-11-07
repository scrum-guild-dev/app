import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { modalState } from './toast.svelte.ts';
import { ShortcutHints } from './shortcut-hints.svelte.ts';
import { ShortcutRegistry, type Shortcut } from './shortcuts.svelte.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('innerHeight', 800);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  modalState.openCount = 0;
});

function anchor(attributes: Record<string, string> = {}, rect = { right: 200, top: 40, width: 30, height: 24 }) {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    getBoundingClientRect: () => ({ ...rect, left: rect.right - rect.width, bottom: rect.top + rect.height }),
  } as unknown as HTMLElement;
}

function shortcut(overrides: Partial<Shortcut> = {}): Shortcut {
  return { id: 'next', keys: ']', label: () => '次', run: () => {}, hintAnchor: () => anchor(), ...overrides };
}

function key(key: string, overrides: Record<string, unknown> = {}) {
  return { key, repeat: false, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...overrides };
}

function setup(items: Shortcut[], options: { mac?: boolean; touch?: boolean; target?: EventTarget | null } = {}) {
  const registry = new ShortcutRegistry();
  for (const item of items) registry.register(item);
  const state = new ShortcutHints({
    registry,
    mac: options.mac ?? false,
    isTouch: () => options.touch ?? false,
    target: () => options.target ?? null,
  });
  return { state, registry };
}

describe('押し続けて出す', () => {
  test('Ctrl を約0.3秒押し続けると出て、離すと消える。位置は角の外へ少し出す', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(299);
    expect(state.hints).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(state.hints).toEqual([{ id: 'next', text: ']', right: 206, top: 40 }]);
    state.keyup(key('Control'));
    expect(state.hints).toEqual([]);
  });

  test('Mac は ⌘（Meta）で出し、Ctrl では出さない。Mod のキーは ⌘K と見せる', () => {
    const { state } = setup([shortcut({ id: 'search', keys: 'Mod+K', inTyping: true })], { mac: true });
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(400);
    expect(state.hints).toEqual([]);
    state.keydown(key('Meta', { metaKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints.map((hint) => hint.text)).toEqual(['⌘K']);
  });

  test('Windows と Linux の Mod のキーは Ctrl K と見せる', () => {
    const { state } = setup([shortcut({ keys: 'Mod+K', inTyping: true })]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints.map((hint) => hint.text)).toEqual(['Ctrl K']);
  });

  test('待つ間に別のキー（⌘C など）が押されたら出さない。出た後に押しても消える', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(200);
    state.keydown(key('c', { ctrlKey: true }));
    vi.advanceTimersByTime(500);
    expect(state.hints).toEqual([]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints).toHaveLength(1);
    state.keydown(key('c', { ctrlKey: true }));
    expect(state.hints).toEqual([]);
  });

  test('押しっぱなしの繰り返しで待ちを延ばさず、Alt、Shift、反対の修飾キーが一緒なら出さない', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(200);
    state.keydown(key('Control', { ctrlKey: true, repeat: true }));
    vi.advanceTimersByTime(100);
    expect(state.hints).toHaveLength(1);
    state.cancel();
    for (const extra of [{ altKey: true }, { shiftKey: true }, { metaKey: true }]) {
      state.keydown(key('Control', { ctrlKey: true, ...extra }));
      vi.advanceTimersByTime(500);
      expect(state.hints).toEqual([]);
    }
  });

  test('cancel（ウィンドウやタブを離れる）で消え、待ちも取り消す。押し直すまで出さない', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    state.cancel();
    vi.advanceTimersByTime(500);
    expect(state.hints).toEqual([]);
    // 押しっぱなしの繰り返しでは出し直さない
    state.keydown(key('Control', { ctrlKey: true, repeat: true }));
    vi.advanceTimersByTime(500);
    expect(state.hints).toEqual([]);
  });

  test('dismiss（スクロールなど）は、押し続ければ約0.3秒後に出し直す。keydown の繰り返しが届かなくてもよい', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(100);
    state.dismiss();
    vi.advanceTimersByTime(299);
    expect(state.hints).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(state.hints).toHaveLength(1);
    // 出ているヒントも消し、約0.3秒後にまた出す（繰り返しの keydown は無い）
    state.dismiss();
    expect(state.hints).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(state.hints).toHaveLength(1);
  });

  test('スクロール中に続けて dismiss が呼ばれる間は出し直さず、止まって約0.3秒後に出す', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) {
      state.dismiss();
      vi.advanceTimersByTime(100);
      expect(state.hints).toEqual([]);
    }
    vi.advanceTimersByTime(200);
    expect(state.hints).toHaveLength(1);
  });

  test('離したら、dismiss の後でも出し直さない', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    state.dismiss();
    state.keyup(key('Control'));
    vi.advanceTimersByTime(500);
    expect(state.hints).toEqual([]);
  });

  test('修飾キーの2つ目の keydown（左右の Ctrl のロールオーバー）で待ちを二重にせず、離した後に出さない', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(100);
    state.keydown(key('Control', { ctrlKey: true }));
    state.keyup(key('Control'));
    vi.advanceTimersByTime(500);
    expect(state.hints).toEqual([]);
  });

  test('出ているときに、ほかのキーを離しても消えない', () => {
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    state.keyup(key('a'));
    expect(state.hints).toHaveLength(1);
  });

  test('タブが隠れているときは出さない', () => {
    vi.stubGlobal('document', { hidden: true });
    const { state } = setup([shortcut()]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(500);
    expect(state.hints).toEqual([]);
  });

  test('タッチの端末では出さない', () => {
    const { state } = setup([shortcut()], { touch: true });
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(500);
    expect(state.hints).toEqual([]);
  });
});

describe('出す対象', () => {
  test('押せない（enabled が false）もの、押せない状態（aria-disabled）の要素、要素の無いもの、見えない要素には出さない', () => {
    const { state } = setup([
      shortcut({ id: 'off', keys: '[', enabled: () => false }),
      shortcut({ id: 'disabled', keys: ']', hintAnchor: () => anchor({ 'aria-disabled': 'true' }) }),
      shortcut({ id: 'none', keys: 'c', hintAnchor: () => null }),
      shortcut({ id: 'hidden', keys: 'x', hintAnchor: () => anchor({}, { right: 0, top: 0, width: 0, height: 0 }) }),
      shortcut({
        id: 'below',
        keys: 'y',
        hintAnchor: () => anchor({}, { right: 100, top: 900, width: 30, height: 24 }),
      }),
      shortcut({ id: 'ok', keys: 'z' }),
    ]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints.map((hint) => hint.id)).toEqual(['ok']);
  });

  test('文字を打つ場所では単キーを出さず、inTyping のものだけ出す', () => {
    const input = { tagName: 'INPUT', type: 'text', isContentEditable: false } as unknown as EventTarget;
    const { state } = setup(
      [shortcut({ id: 'single', keys: ']' }), shortcut({ id: 'search', keys: 'Mod+K', inTyping: true })],
      { target: input },
    );
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints.map((hint) => hint.id)).toEqual(['search']);
  });

  test('モーダルのダイアログが開いている間は、inModal のものだけ出す', () => {
    modalState.openCount = 1;
    const { state } = setup([
      shortcut({ id: 'page', keys: '[' }),
      shortcut({ id: 'drawer', keys: ']', inModal: true }),
    ]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints.map((hint) => hint.id)).toEqual(['drawer']);
  });

  test('左端で切れる小さな要素では、キーの幅の分だけ内側に寄せる。画面の横の外にある要素には出さない', () => {
    const { state } = setup([
      shortcut({
        id: 'near',
        keys: 'Mod+K',
        inTyping: true,
        hintAnchor: () => anchor({}, { right: 20, top: 40, width: 20, height: 24 }),
      }),
      shortcut({
        id: 'outside',
        keys: '[',
        hintAnchor: () => anchor({}, { right: 1500, top: 40, width: 30, height: 24 }),
      }),
    ]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    // 'Ctrl K' は 6 文字 → 幅 64、左の余白 4 を足して 68
    expect(state.hints).toEqual([{ id: 'near', text: 'Ctrl K', right: 68, top: 40 }]);
  });

  test('出ている間にモーダルのダイアログが開き、dismiss で出し直しを張っても、inModal でないものは出さない', () => {
    const { state } = setup([
      shortcut({ id: 'page', keys: '[' }),
      shortcut({ id: 'drawer', keys: ']', inModal: true }),
    ]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints.map((hint) => hint.id)).toEqual(['page', 'drawer']);
    modalState.openCount = 1;
    state.dismiss();
    vi.advanceTimersByTime(300);
    expect(state.hints.map((hint) => hint.id)).toEqual(['drawer']);
  });

  test('同じ要素に重ねて出さず、右端は画面の内側に寄せる', () => {
    const shared = anchor({}, { right: 995, top: 2, width: 30, height: 24 });
    const { state } = setup([
      shortcut({ id: 'a', keys: '[', hintAnchor: () => shared }),
      shortcut({ id: 'b', keys: ']', hintAnchor: () => shared }),
    ]);
    state.keydown(key('Control', { ctrlKey: true }));
    vi.advanceTimersByTime(300);
    expect(state.hints).toEqual([{ id: 'a', text: '[', right: 996, top: 22 }]);
  });
});
