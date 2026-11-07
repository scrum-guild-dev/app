import { describe, expect, test } from 'vitest';
import {
  ariaKeyshortcuts,
  hintText,
  isMacPlatform,
  isComposingKey,
  isTypingTarget,
  matchesKeys,
  normalizeKeys,
  parseKeys,
} from './shortcut-keys.ts';

const base = { key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe('parseKeys と normalizeKeys', () => {
  test('Mod 付きは小文字にそろえ、単キーは文字のまま', () => {
    expect(parseKeys('Mod+K')).toEqual({ mod: true, key: 'k' });
    expect(parseKeys('[')).toEqual({ mod: false, key: '[' });
    expect(normalizeKeys('Mod+k')).toBe(normalizeKeys('Mod+K'));
    expect(normalizeKeys('c')).not.toBe(normalizeKeys('C'));
  });

  test('続けて押すキーは、1つ目を prefix に分ける', () => {
    expect(parseKeys('g b')).toEqual({ mod: false, key: 'b', prefix: 'g' });
    expect(normalizeKeys('g b')).toBe('g b');
    expect(() => ariaKeyshortcuts('g b')).toThrow();
    for (const bad of ['g  b', 'g bb', 'g b c', 'Mod+g b', ' b']) expect(() => parseKeys(bad), bad).toThrow();
  });

  test('読めない書き方は例外にする', () => {
    expect(() => parseKeys('')).toThrow();
    expect(() => parseKeys('Mod+')).toThrow();
    expect(() => parseKeys('ab')).toThrow();
    expect(() => parseKeys('Mod+ab')).toThrow();
  });
});

describe('matchesKeys', () => {
  const mod = parseKeys('Mod+K');
  const plain = parseKeys('[');

  test('Mod+K は Ctrl か ⌘ と K（大文字小文字を問わない）で当たる', () => {
    expect(matchesKeys(mod, { ...base, ctrlKey: true })).toBe(true);
    expect(matchesKeys(mod, { ...base, metaKey: true })).toBe(true);
    expect(matchesKeys(mod, { ...base, metaKey: true, key: 'K' })).toBe(true);
  });

  test('Mod+K は修飾キーなし、Alt 付き、Shift 付き、別のキーでは当たらない', () => {
    expect(matchesKeys(mod, base)).toBe(false);
    expect(matchesKeys(mod, { ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(matchesKeys(mod, { ...base, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(matchesKeys(mod, { ...base, ctrlKey: true, key: 'j' })).toBe(false);
  });

  test('単キーは同じ文字だけで当たり、Ctrl、⌘、Alt 付きでは当たらない', () => {
    expect(matchesKeys(plain, { ...base, key: '[' })).toBe(true);
    expect(matchesKeys(plain, { ...base, key: ']' })).toBe(false);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(matchesKeys(plain, { ...base, key: '[', [modifier]: true })).toBe(false);
    }
  });

  test('単キーは Shift を見ない。Shift で出る文字は、出た key の文字で当てる', () => {
    expect(matchesKeys(parseKeys('?'), { ...base, key: '?', shiftKey: true })).toBe(true);
    expect(matchesKeys(plain, { ...base, key: '[', shiftKey: true })).toBe(true);
    expect(matchesKeys(plain, { ...base, key: '{', shiftKey: true })).toBe(false);
  });

  test('単キーの英字は大文字小文字を区別する', () => {
    expect(matchesKeys(parseKeys('c'), { ...base, key: 'c' })).toBe(true);
    expect(matchesKeys(parseKeys('c'), { ...base, key: 'C', shiftKey: true })).toBe(false);
  });
});

describe('ariaKeyshortcuts', () => {
  test('Mod は Control と Meta の両方、単キーはそのまま', () => {
    expect(ariaKeyshortcuts('Mod+K')).toBe('Control+K Meta+K');
    expect(ariaKeyshortcuts('[')).toBe('[');
  });
});

describe('isComposingKey', () => {
  test('isComposing か keyCode 229 のとき真', () => {
    expect(isComposingKey({ isComposing: true, keyCode: 0 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 221 })).toBe(false);
  });
});

function targetOf(tagName: string, type?: string, isContentEditable = false): EventTarget {
  return { tagName, type, isContentEditable } as unknown as EventTarget;
}

describe('isTypingTarget', () => {
  test.each([
    '',
    'text',
    'search',
    'url',
    'email',
    'tel',
    'password',
    'number',
    'date',
    'datetime-local',
    'month',
    'week',
    'time',
  ])('文字や数字を入れる input（%s）は打つ場所', (type) => {
    expect(isTypingTarget(targetOf('INPUT', type))).toBe(true);
  });

  test('type が無い input、textarea、select、contenteditable は打つ場所', () => {
    expect(isTypingTarget(targetOf('INPUT', undefined))).toBe(true);
    expect(isTypingTarget(targetOf('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(targetOf('SELECT'))).toBe(true);
    expect(isTypingTarget(targetOf('DIV', undefined, true))).toBe(true);
  });

  test.each(['radio', 'checkbox', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])(
    '文字を打たない input（%s）は打つ場所ではない',
    (type) => {
      expect(isTypingTarget(targetOf('INPUT', type))).toBe(false);
    },
  );

  test('ボタン、リンク、要素でないもの、null は打つ場所ではない', () => {
    expect(isTypingTarget(targetOf('BUTTON'))).toBe(false);
    expect(isTypingTarget(targetOf('A'))).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

describe('hintText と isMacPlatform', () => {
  test('Mod は Mac が ⌘K、ほかは Ctrl K。単キーはそのまま', () => {
    expect(hintText('Mod+K', true)).toBe('⌘K');
    expect(hintText('Mod+k', false)).toBe('Ctrl K');
    expect(hintText('[', true)).toBe('[');
    expect(hintText('g b', false)).toBe('g b');
  });

  test('Mac、iPhone、iPad を Mac 系と見る', () => {
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('iPhone')).toBe(true);
    expect(isMacPlatform('Win32')).toBe(false);
    expect(isMacPlatform('')).toBe(false);
  });
});
