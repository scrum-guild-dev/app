import { afterEach, describe, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import { modalState } from './toast.svelte.ts';
import { ShortcutRegistry, useShortcut, type Shortcut } from './shortcuts.svelte.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  modalState.openCount = 0;
});

function keyEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: '[',
    keyCode: 219,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: { tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function make(overrides: Partial<Shortcut> = {}): Shortcut & { run: ReturnType<typeof vi.fn> } {
  return { id: 'test', keys: '[', label: () => 'テスト', run: vi.fn(), ...overrides } as Shortcut & {
    run: ReturnType<typeof vi.fn>;
  };
}

describe('登録と振り分け', () => {
  test('当たるキーで run を呼び、preventDefault する', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make();
    registry.register(shortcut);
    const event = keyEvent();
    expect(registry.handle(event)).toBe(true);
    expect(shortcut.run).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  test('当たらないキーでは何もせず、preventDefault もしない', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make();
    registry.register(shortcut);
    const event = keyEvent({ key: ']' });
    expect(registry.handle(event)).toBe(false);
    expect(shortcut.run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('解除したあとは働かない。items も作り直される', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make();
    const unregister = registry.register(shortcut);
    expect(registry.items).toEqual([shortcut]);
    unregister();
    expect(registry.items).toEqual([]);
    expect(registry.handle(keyEvent())).toBe(false);
    expect(shortcut.run).not.toHaveBeenCalled();
  });

  test('日本語の変換中（isComposing か keyCode 229）と、ほかの処理が受けたキーには働かない', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make();
    registry.register(shortcut);
    expect(registry.handle(keyEvent({ isComposing: true }))).toBe(false);
    expect(registry.handle(keyEvent({ keyCode: 229 }))).toBe(false);
    expect(registry.handle(keyEvent({ defaultPrevented: true }))).toBe(false);
    expect(shortcut.run).not.toHaveBeenCalled();
  });

  test('押しっぱなしの繰り返しには、repeat を許したものだけ run を呼ぶ。許さない単キーはキーも奪わない', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make();
    const repeating = make({ id: 'repeating', keys: ']', repeat: true });
    registry.register(shortcut);
    registry.register(repeating);
    const held = keyEvent({ repeat: true });
    expect(registry.handle(held)).toBe(false);
    expect(held.preventDefault).not.toHaveBeenCalled();
    expect(shortcut.run).not.toHaveBeenCalled();
    expect(registry.handle(keyEvent({ key: ']', repeat: true }))).toBe(true);
    expect(repeating.run).toHaveBeenCalledTimes(1);
  });

  describe('Mod 付きのキーの押しっぱなし', () => {
    const held = { key: 'k', ctrlKey: true, repeat: true };
    const inInput = { tagName: 'INPUT', type: 'text', isContentEditable: false } as unknown as EventTarget;

    test('run せずにキーだけ奪う（ブラウザの標準の Ctrl+K を動かさない）', () => {
      const registry = new ShortcutRegistry();
      const shortcut = make({ keys: 'Mod+K', inTyping: true });
      registry.register(shortcut);
      const event = keyEvent(held);
      expect(registry.handle(event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shortcut.run).not.toHaveBeenCalled();
    });

    test('inTyping でないものは、入力欄の中の長押しを奪わない', () => {
      const registry = new ShortcutRegistry();
      registry.register(make({ keys: 'Mod+K' }));
      const event = keyEvent({ ...held, target: inInput });
      expect(registry.handle(event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test('enabled が false の間は奪わない', () => {
      const registry = new ShortcutRegistry();
      registry.register(make({ keys: 'Mod+K', inTyping: true, enabled: () => false }));
      const event = keyEvent(held);
      expect(registry.handle(event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test('モーダルのダイアログが開いている間は奪わない', () => {
      const registry = new ShortcutRegistry();
      registry.register(make({ keys: 'Mod+K', inTyping: true }));
      modalState.openCount = 1;
      const event = keyEvent(held);
      expect(registry.handle(event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  test('Mod+K も、変換中（isComposing、keyCode 229）には働かない', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make({ keys: 'Mod+K', inTyping: true });
    registry.register(shortcut);
    const base = { key: 'k', ctrlKey: true };
    expect(registry.handle(keyEvent({ ...base, isComposing: true }))).toBe(false);
    expect(registry.handle(keyEvent({ ...base, keyCode: 229 }))).toBe(false);
    expect(registry.handle(keyEvent(base))).toBe(true);
  });

  test('キーの先が無い（null、undefined、要素でない）ときも働く', () => {
    const registry = new ShortcutRegistry();
    registry.register(make());
    expect(registry.handle(keyEvent({ target: null }))).toBe(true);
    expect(registry.handle(keyEvent({ target: undefined }))).toBe(true);
    expect(registry.handle(keyEvent({ target: {} }))).toBe(true);
  });

  test('enabled が false の間は働かず、preventDefault もしない', () => {
    const registry = new ShortcutRegistry();
    let enabled = false;
    const shortcut = make({ enabled: () => enabled });
    registry.register(shortcut);
    const first = keyEvent();
    expect(registry.handle(first)).toBe(false);
    expect(first.preventDefault).not.toHaveBeenCalled();
    enabled = true;
    expect(registry.handle(keyEvent())).toBe(true);
  });
});

describe('入力欄とダイアログ', () => {
  const inInput = { tagName: 'INPUT', type: 'text', isContentEditable: false } as unknown as EventTarget;

  test('文字を打つ場所では、inTyping のものだけ働く', () => {
    const registry = new ShortcutRegistry();
    const single = make();
    const modified = make({ id: 'mod', keys: 'Mod+K', inTyping: true });
    registry.register(single);
    registry.register(modified);
    expect(registry.handle(keyEvent({ target: inInput }))).toBe(false);
    expect(registry.handle(keyEvent({ key: 'k', ctrlKey: true, target: inInput }))).toBe(true);
    expect(single.run).not.toHaveBeenCalled();
    expect(modified.run).toHaveBeenCalledTimes(1);
  });

  test('文字を打たない input（radio）にフォーカスがあっても働く', () => {
    const registry = new ShortcutRegistry();
    registry.register(make());
    const radio = { tagName: 'INPUT', type: 'radio', isContentEditable: false } as unknown as EventTarget;
    expect(registry.handle(keyEvent({ target: radio }))).toBe(true);
  });

  test('モーダルのダイアログ（modalState）が開いている間は、inModal のものだけ働く', () => {
    const registry = new ShortcutRegistry();
    const normal = make();
    const inside = make({ id: 'inside', keys: ']', inModal: true });
    registry.register(normal);
    registry.register(inside);
    modalState.openCount = 1;
    expect(registry.handle(keyEvent())).toBe(false);
    expect(registry.handle(keyEvent({ key: ']' }))).toBe(true);
  });

  test('開いた dialog 要素があるときも、inModal のものだけ働く', () => {
    vi.stubGlobal('document', { querySelector: () => ({}) });
    const registry = new ShortcutRegistry();
    registry.register(make());
    registry.register(make({ id: 'inside', keys: ']', inModal: true }));
    expect(registry.handle(keyEvent())).toBe(false);
    expect(registry.handle(keyEvent({ key: ']' }))).toBe(true);
  });
});

describe('衝突の検出', () => {
  test('同じキーを同時に2つ登録すると、開発中は例外にする（Mod+K と Mod+k も同じ）', () => {
    const registry = new ShortcutRegistry();
    registry.register(make({ id: 'a', keys: 'Mod+K' }));
    expect(() => registry.register(make({ id: 'b', keys: 'Mod+k' }))).toThrow(/a と b/);
    expect(registry.items).toHaveLength(1);
  });

  test('解除したあとなら、同じキーを登録し直せる', () => {
    const registry = new ShortcutRegistry();
    const unregister = registry.register(make({ id: 'a' }));
    unregister();
    expect(() => registry.register(make({ id: 'b' }))).not.toThrow();
  });

  test('本番（DEV でない）では例外にせず、後の登録を無視して先の登録を残す', () => {
    vi.stubEnv('DEV', false);
    const registry = new ShortcutRegistry();
    const first = make({ id: 'a' });
    const second = make({ id: 'b' });
    registry.register(first);
    const unregister = registry.register(second);
    unregister();
    expect(registry.items).toEqual([first]);
    registry.handle(keyEvent());
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
  });
});

describe('useShortcut（部品の置かれている間だけ登録する）', () => {
  test('開発中に同じキーを2回登録すると、衝突を例外で知らせる', async () => {
    const { shortcuts } = await import('./shortcuts.svelte.ts');
    const first = make({ id: 'dup-a', keys: 'd' });
    const second = make({ id: 'dup-b', keys: 'd' });
    const dispose = $effect.root(() => {
      useShortcut(() => first);
      useShortcut(() => second);
    });
    expect(() => flushSync()).toThrow(/dup-a と dup-b/);
    dispose();
    flushSync();
    expect(shortcuts.items.map((item) => item.id)).not.toContain('dup-a');
  });

  test('続けて押すキー: 1つ目で待ち、1秒以内の2つ目で働く。1つ目と2つ目は preventDefault する', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make({ keys: 'g b' });
    registry.register(shortcut);
    const first = keyEvent({ key: 'g' });
    expect(registry.handle(first)).toBe(true);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(shortcut.run).not.toHaveBeenCalled();
    expect(registry.handle(keyEvent({ key: 'b' }))).toBe(true);
    expect(shortcut.run).toHaveBeenCalledTimes(1);
    // 待ちは使い切る。単独の b は働かない
    expect(registry.handle(keyEvent({ key: 'b' }))).toBe(false);
  });

  test('続けて押すキー: 約1秒たつと待ちが切れる。Shift だけの押下では切れない', () => {
    vi.useFakeTimers();
    try {
      const registry = new ShortcutRegistry();
      const shortcut = make({ keys: 'g b' });
      registry.register(shortcut);
      registry.handle(keyEvent({ key: 'g' }));
      vi.advanceTimersByTime(900);
      registry.handle(keyEvent({ key: 'Shift', shiftKey: true }));
      expect(registry.handle(keyEvent({ key: 'b' }))).toBe(true);
      registry.handle(keyEvent({ key: 'g' }));
      vi.advanceTimersByTime(1100);
      expect(registry.handle(keyEvent({ key: 'b' }))).toBe(false);
      expect(shortcut.run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('続けて押すキー: 待ち中に別のキーを押すと待ちが切れる', () => {
    const registry = new ShortcutRegistry();
    const shortcut = make({ keys: 'g b' });
    registry.register(shortcut);
    registry.handle(keyEvent({ key: 'g' }));
    registry.handle(keyEvent({ key: 'x' }));
    expect(registry.handle(keyEvent({ key: 'b' }))).toBe(false);
    expect(shortcut.run).not.toHaveBeenCalled();
  });

  test('続けて押すキー: 文字を打つ場所、ダイアログ、変換中では待ちに入らず、文字は通る', () => {
    const registry = new ShortcutRegistry();
    registry.register(make({ keys: 'g b' }));
    const typing = keyEvent({ key: 'g', target: { tagName: 'INPUT', type: 'text' } as unknown as EventTarget });
    expect(registry.handle(typing)).toBe(false);
    expect(typing.preventDefault).not.toHaveBeenCalled();
    expect(registry.handle(keyEvent({ key: 'b' }))).toBe(false);
    modalState.openCount = 1;
    expect(registry.handle(keyEvent({ key: 'g' }))).toBe(false);
    modalState.openCount = 0;
    expect(registry.handle(keyEvent({ key: 'g', isComposing: true, keyCode: 229 }))).toBe(false);
  });

  test('続けて押すキー: 続きが enabled でない間は 1つ目を奪わない', () => {
    const registry = new ShortcutRegistry();
    registry.register(make({ keys: 'g b', enabled: () => false }));
    const first = keyEvent({ key: 'g' });
    expect(registry.handle(first)).toBe(false);
    expect(first.preventDefault).not.toHaveBeenCalled();
  });

  test('続けて押すキーの1つ目と同じ単キーの登録は重なりになる（どちらの順でも）', () => {
    vi.stubEnv('DEV', true);
    const registry = new ShortcutRegistry();
    registry.register(make({ id: 'chord', keys: 'g b' }));
    expect(() => registry.register(make({ id: 'single', keys: 'g' }))).toThrow(/重なっています/);
    const other = new ShortcutRegistry();
    other.register(make({ id: 'single', keys: 'g' }));
    expect(() => other.register(make({ id: 'chord', keys: 'g b' }))).toThrow(/重なっています/);
    // 1つ目が同じで2つ目が違うのは重ならない
    expect(() => registry.register(make({ id: 'chord2', keys: 'g s' }))).not.toThrow();
  });

  test('部品が置かれると登録し、外れると解除する', async () => {
    const { shortcuts } = await import('./shortcuts.svelte.ts');
    const shortcut = make({ id: 'use-shortcut-test', keys: 'u' });
    const dispose = $effect.root(() => {
      useShortcut(() => shortcut);
    });
    flushSync();
    expect(shortcuts.items).toContain(shortcut);
    expect(shortcuts.handle(keyEvent({ key: 'u' }))).toBe(true);
    dispose();
    flushSync();
    expect(shortcuts.items).not.toContain(shortcut);
    expect(shortcuts.handle(keyEvent({ key: 'u' }))).toBe(false);
  });
});
