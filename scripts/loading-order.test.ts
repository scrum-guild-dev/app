import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parallelRead } from './loading-order.ts';
test('逆順に発行しても操作と結果の対応を保つ', async () => {
  const calls: string[] = [];
  const pending = new Map<string, (result: number) => void>();
  const values = ['main', 'secondary', 'other'];
  const promise = parallelRead(values, true, (value) => {
    calls.push(value);
    return new Promise<number>((resolve) => pending.set(value, resolve));
  });
  assert.deepEqual(calls, ['other', 'secondary', 'main']);
  pending.get('secondary')!(20);
  pending.get('main')!(10);
  pending.get('other')!(30);
  assert.deepEqual(await promise, [10, 20, 30]);
  assert.deepEqual(values, ['main', 'secondary', 'other']);
});
test('正順と空の群を保つ', async () => {
  const calls: number[] = [];
  assert.deepEqual(
    await parallelRead([1, 2], false, async (value) => {
      calls.push(value);
      return value * 2;
    }),
    [2, 4],
  );
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(await parallelRead([], true, async () => 1), []);
});
