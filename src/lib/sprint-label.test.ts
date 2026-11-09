import { expect, test } from 'vitest';
import { word } from '../shared/vocabulary.ts';
import { completedMessage } from './sprint-label.ts';
test('完了の知らせは実際の経験値を次の1行に添え、0なら省く', () => {
  expect(completedMessage(false, 40, word)).toBe(`${completedMessage(false, 0, word)}\n+40 XP`);
  expect(completedMessage(false, 0, word)).not.toContain('XP');
  expect(completedMessage(true, 15, word)).toBe(`${completedMessage(true, 0, word)}\n+15 XP`);
  expect(completedMessage(true, 0, word)).toContain('から外れました');
});
