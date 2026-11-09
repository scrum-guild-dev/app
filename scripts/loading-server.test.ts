import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isBenchHealth, trackServer } from './loading-server.ts';
test('別の開発サーバーの health を受け付けない', () => {
  const health = { status: 'ok', database: 'ok', credentialKeys: 'ok', version: 'dev' };
  assert.equal(isBenchHealth(health, 'unique-bench'), false);
  assert.equal(isBenchHealth({ ...health, version: 'unique-bench' }, 'unique-bench'), true);
  assert.equal(isBenchHealth({ status: 'ok', database: 'ok', version: 'unique-bench' }, 'unique-bench'), false);
  assert.equal(
    isBenchHealth({ ...health, credentialKeys: 'unavailable', version: 'unique-bench' }, 'unique-bench'),
    false,
  );
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

test(
  '親が先に終了しても同じグループの孫サーバーを止める',
  { skip: process.platform === 'win32', timeout: 4000 },
  async () => {
    const code = `const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "require('node:http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], {stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', data => {console.log(data.toString().trim()); process.exit(0)});`;
    const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const server = trackServer(child, true);
    const exited = once(child, 'exit');
    const port = Number((await once(child.stdout!, 'data'))[0].toString().trim());
    await exited;
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
    try {
      await server.stop();
      await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }));
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* テストが作ったグループのみ */
      }
    }
  },
);
