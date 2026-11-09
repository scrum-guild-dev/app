import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTrial, type ReadResponse } from './loading-trial.ts';

for (const reverse of [false, true]) {
  test(`${reverse ? '逆順' : '正順'}でも全群の最後の応答後にだけ出力を検査し、元の操作順と共通開始時刻を保つ`, async () => {
    const calls: string[] = [];
    const validated: string[] = [];
    const pending = new Map<string, (value: ReadResponse) => void>();
    const trial = readTrial(
      ['main', 'secondary'],
      ['after-main', 'after-secondary'],
      reverse,
      (name) => {
        calls.push(name);
        return new Promise<ReadResponse>((resolve) => pending.set(name, resolve));
      },
      () => 100,
    );
    const finish = (name: string, finishedAt: number) =>
      pending.get(name)!({
        ms: finishedAt - 110,
        finishedAt,
        secondary: name.includes('secondary'),
        body: { name },
        validate: (body) => {
          assert.deepEqual(body, { name });
          validated.push(name);
        },
      });
    assert.deepEqual(calls, reverse ? ['secondary', 'main'] : ['main', 'secondary']);
    finish('main', 120);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(validated, []);
    assert.equal(calls.length, 2, '先行群の完了前にafterを開始しない');
    finish('secondary', 130);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(validated, [], '先行群の検査をafterと重ねない');
    assert.deepEqual(calls.slice(2), reverse ? ['after-secondary', 'after-main'] : ['after-main', 'after-secondary']);
    finish('after-main', 140);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(validated, [], '最後の応答まで検査しない');
    finish('after-secondary', 150);
    assert.deepEqual(await trial, [
      { ms: 10, secondary: false, completedMs: 20 },
      { ms: 20, secondary: true, completedMs: 30 },
      { ms: 30, secondary: false, completedMs: 40 },
      { ms: 40, secondary: true, completedMs: 50 },
    ]);
    assert.deepEqual(validated, ['main', 'secondary', 'after-main', 'after-secondary']);
  });
}

test('出力スキーマが不正なら応答時間が揃っていても試行全体を失敗にする', async () => {
  const received: string[] = [];
  await assert.rejects(
    readTrial(['bad'], ['after'], false, async (name) => {
      received.push(name);
      return {
        ms: 10,
        finishedAt: 110,
        secondary: false,
        body: { invalid: true },
        validate: () => {
          assert.deepEqual(received, ['bad', 'after']);
          throw new Error('応答の形が不正');
        },
      };
    }),
    /応答の形が不正/,
  );
});
