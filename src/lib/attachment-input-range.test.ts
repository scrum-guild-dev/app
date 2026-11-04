import { describe, expect, it } from 'vitest';
import { moveMarkdownInsertion, resolveInputEdit } from './attachment-upload.ts';

describe('actual textarea edit ranges', () => {
  it('uses native selections for insertions and replacements, preserving repeated-prefix distinctions', () => {
    expect(resolveInputEdit('!abc', '!!abc', { start: 0, end: 0, inputType: 'insertText' })).toEqual({
      start: 0,
      end: 0,
    });
    expect(resolveInputEdit('!abc', '!!abc', { start: 1, end: 1, inputType: 'insertText' })).toEqual({
      start: 1,
      end: 1,
    });
    expect(
      resolveInputEdit('before OLD after', 'before new after', { start: 7, end: 10, inputType: 'insertFromPaste' }),
    ).toEqual({ start: 7, end: 10 });
  });
  it('resolves backspace and forward-delete by the actual removed UTF-16 length', () => {
    expect(resolveInputEdit('a😀b', 'ab', { start: 3, end: 3, inputType: 'deleteContentBackward' })).toEqual({
      start: 1,
      end: 3,
    });
    expect(resolveInputEdit('a😀b', 'ab', { start: 1, end: 1, inputType: 'deleteContentForward' })).toEqual({
      start: 1,
      end: 3,
    });
    expect(resolveInputEdit('one two', 'one ', { start: 7, end: 7, inputType: 'deleteWordBackward' })).toEqual({
      start: 4,
      end: 7,
    });
    expect(resolveInputEdit('abc', 'ac', { start: 1, end: 2, inputType: 'deleteByCut' })).toEqual({ start: 1, end: 2 });
  });
  it('does not treat undo or stale/unmatched selections as a known edit', () => {
    expect(resolveInputEdit('abc', 'abcd', { start: 3, end: 3, inputType: 'historyUndo' })).toBeUndefined();
    expect(resolveInputEdit('abc', 'Xabc', { start: 2, end: 2, inputType: 'insertText' })).toBeUndefined();
    expect(resolveInputEdit('abc', 'abc', { start: 0, end: 0, inputType: 'deleteContentBackward' })).toBeUndefined();
  });
  it('maps pending image ownership through exact deletions around and inside its token', () => {
    const token = '![image](/api/aoba/attachments/id)';
    const before = '!!' + token + 'xx';
    const insertion = { start: 2, text: token };
    const backward = resolveInputEdit(before, '!' + token + 'xx', {
      start: 2,
      end: 2,
      inputType: 'deleteContentBackward',
    });
    expect(moveMarkdownInsertion(before, '!' + token + 'xx', insertion, backward)).toEqual({ start: 1, text: token });
    const forward = resolveInputEdit(before, '!!' + token + 'x', {
      start: 2 + token.length,
      end: 2 + token.length,
      inputType: 'deleteContentForward',
    });
    expect(moveMarkdownInsertion(before, '!!' + token + 'x', insertion, forward)).toEqual(insertion);
    const inside = resolveInputEdit(before, '!!' + token.slice(1) + 'xx', {
      start: 3,
      end: 3,
      inputType: 'deleteContentBackward',
    });
    expect(moveMarkdownInsertion(before, '!!' + token.slice(1) + 'xx', insertion, inside)).toBeUndefined();
  });
});
