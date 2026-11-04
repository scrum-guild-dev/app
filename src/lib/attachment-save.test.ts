import { expect, test } from 'vitest';
import { attachmentSaveFailure } from './attachment-save.ts';

test('添付の不存在だけを取り除き、ほかの未保存ファイルを残す', () => {
  const pending = ['missing', 'keep'];
  expect(
    attachmentSaveFailure(404, { code: 'not_found', message: '', details: { attachment_ids: ['missing'] } }, pending),
  ).toContain('もう一度追加');
  expect(pending).toEqual(['keep']);
});

test('保存先の不存在は添付の失敗として扱わない', () => {
  const pending = ['keep'];
  expect(attachmentSaveFailure(404, { code: 'not_found', message: '' }, pending)).toBeNull();
  expect(pending).toEqual(['keep']);
});

test('保存済みの添付だけを保留から外し、本文を確認するよう伝える', () => {
  const pending = ['attached', 'keep'];
  expect(
    attachmentSaveFailure(
      409,
      { code: 'conflict', message: '', details: { reason: 'attachment_attached', attachment_ids: ['attached'] } },
      pending,
    ),
  ).toContain('内容を確認');
  expect(pending).toEqual(['keep']);
});

test('添付以外の競合と不正な詳細は保留を変更しない', () => {
  const pending = ['keep'];
  expect(
    attachmentSaveFailure(
      409,
      { code: 'conflict', message: '', details: { reason: 'changed', attachment_ids: ['keep'] } },
      pending,
    ),
  ).toBeNull();
  expect(
    attachmentSaveFailure(404, { code: 'not_found', message: '', details: { attachment_ids: [1] } }, pending),
  ).toBeNull();
  expect(pending).toEqual(['keep']);
});
