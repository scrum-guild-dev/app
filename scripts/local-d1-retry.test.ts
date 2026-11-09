import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryLocalD1 } from './local-d1-retry.ts';

test('SQLITE_BUSY の後は待って同じ操作を再試行し、成功した出力を返す', async () => {
  const waits: number[] = [];
  let calls = 0;
  const success = { status: 0, stdout: '[{"results":[]}]', stderr: '' };
  const result = await retryLocalD1(
    () => (++calls === 1 ? { status: 1, stderr: 'database is locked: SQLITE_BUSY' } : success),
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(result, success);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [500]);
});

test('ロックが続いても3回で止まり、最後のエラーを残す', async () => {
  let calls = 0;
  const waits: number[] = [];
  const failure = { status: 1, stderr: 'SQLITE_BUSY' };
  assert.equal(
    await retryLocalD1(
      () => {
        calls++;
        return failure;
      },
      async (ms) => {
        waits.push(ms);
      },
    ),
    failure,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test('成功、SQL の誤り、起動失敗、シグナル終了は再試行しない', async () => {
  for (const result of [
    { status: 0, stderr: 'SQLITE_BUSY' },
    { status: 1, stderr: 'no such table: tasks' },
    { status: null, error: new Error('ENOENT'), stderr: 'SQLITE_BUSY' },
    { status: null, stderr: 'SQLITE_BUSY' },
  ]) {
    let calls = 0;
    assert.equal(
      await retryLocalD1(
        () => {
          calls++;
          return result;
        },
        async () => assert.fail('待たない'),
      ),
      result,
    );
    assert.equal(calls, 1);
  }
});
