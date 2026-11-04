import { describe, expect, it } from 'vitest';
import { moveMarkdownInsertion } from './attachment-upload.ts';

// 同じ文字列でも、入力した場所によって自動挿入した画像の所有範囲は違う。
// 文字列だけの差分では区別できないので、入力前の選択範囲を渡す。
describe('画像の前後と同じ文字を入力したときの保留範囲', () => {
  const token = '![image](/api/aoba/attachments/019cd824-65aa-7000-8000-000000000001)';
  const insertion = { start: 0, text: token };

  it('画像の直前に ! を入力しても、元の画像は未編集として追跡する', () => {
    expect(moveMarkdownInsertion(token, '!' + token, insertion, { start: 0, end: 0 })).toEqual({
      start: 1,
      text: token,
    });
  });

  it('画像の先頭の ! の直後へ入力した場合は、同じ結果文字列でも編集済みとして扱う', () => {
    expect(moveMarkdownInsertion(token, '!' + token, insertion, { start: 1, end: 1 })).toBeUndefined();
  });
});
