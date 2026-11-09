import { expect, test } from 'vitest';
import { historyEntryView } from './task-history.ts';
import { word } from '../shared/vocabulary.ts';

test('添付削除の履歴は、追加したではなく削除したと表示する', () => {
  const view = historyEntryView(
    {
      id: 'history',
      action: 'update',
      created_at: '2026-11-09T00:00:00.000Z',
      actor: null,
      changes: [{ field: 'attachments', before: 1, after: null }],
    },
    'UTC',
    word,
  );
  expect(view.lines).toEqual([{ label: null, text: '添付ファイルを削除した' }]);
});
