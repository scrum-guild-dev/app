import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';
import { InvitationCount } from './invitation-count.svelte.ts';
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

function gate() {
  let resolve!: (count: number | null) => void;
  const promise = new Promise<number | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  await Promise.resolve();
  flushSync();
}

test('初回を待ち、0件と失敗を区別し、再試行の連打をまとめる', async () => {
  const initial = gate();
  const retry = gate();
  const read = vi.fn(() => retry.promise);
  let count!: InvitationCount;
  const dispose = $effect.root(() => {
    count = new InvitationCount(
      () => initial.promise,
      () => 'aoba',
      read,
    );
  });
  flushSync();
  try {
    expect(count.loading).toBe(true);
    count.retry();
    expect(read).not.toHaveBeenCalled();
    initial.resolve(null);
    await settle();
    expect(count.loading).toBe(false);
    expect(count.count).toBeNull();
    count.retry();
    count.retry();
    flushSync();
    expect(read).toHaveBeenCalledTimes(1);
    expect(count.retrying).toBe(true);
    retry.resolve(0);
    await settle();
    expect(count.loading).toBe(false);
    expect(count.count).toBe(0);
    count.retry();
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
  }
});

test('枠の再読込後に古い初回と再試行が届いても新しい件数を上書きしない', async () => {
  const first = gate();
  const retried = gate();
  const second = gate();
  let initial = $state.raw(first.promise);
  let count!: InvitationCount;
  const dispose = $effect.root(() => {
    count = new InvitationCount(
      () => initial,
      () => 'aoba',
      () => retried.promise,
    );
  });
  flushSync();
  try {
    first.resolve(null);
    await settle();
    count.retry();
    flushSync();
    initial = second.promise;
    expect(count.loading).toBe(true);
    expect(count.retrying).toBe(false);
    flushSync();
    second.resolve(2);
    await settle();
    expect(count.count).toBe(2);
    retried.resolve(9);
    await settle();
    expect(count.count).toBe(2);
  } finally {
    dispose();
  }
});

test('遅い初回応答と枠を離れた後の応答を適用しない', async () => {
  const old = gate();
  const current = gate();
  let initial = $state.raw(old.promise);
  let count!: InvitationCount;
  const dispose = $effect.root(() => {
    count = new InvitationCount(
      () => initial,
      () => 'aoba',
    );
  });
  flushSync();
  initial = current.promise;
  flushSync();
  old.resolve(7);
  await settle();
  expect(count.loading).toBe(true);
  dispose();
  current.resolve(2);
  await settle();
  expect(count.loading).toBe(true);
  expect(count.count).toBeNull();
});
