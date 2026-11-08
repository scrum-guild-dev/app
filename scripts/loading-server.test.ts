import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isBenchHealth, trackServer } from './loading-server.ts';
test('別の開発サーバーの health を受け付けない', () => {
  const health = { status: 'ok', database: 'ok', version: 'dev' };
  assert.equal(isBenchHealth(health, 'unique-bench'), false);
  assert.equal(isBenchHealth({ ...health, version: 'unique-bench' }, 'unique-bench'), true);
  assert.equal(isBenchHealth({ version: 'unique-bench' }, 'unique-bench'), false);
});
test('シグナル終了済みでも後片付けが完了する', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const server = trackServer(child);
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  assert.equal(child.exitCode, null);
  assert.equal(server.stopped, true);
  await server.stop();
});
test('起動失敗でも後片付けが完了する', { timeout: 3000 }, async () => {
  const child = spawn('/nonexistent-loading-bench-executable', [], { stdio: 'ignore' });
  const server = trackServer(child);
  await once(child, 'error');
  assert.equal(server.stopped, true);
  await server.stop();
});
