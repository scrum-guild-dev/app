import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseProcessStat, sampleProcesses, startProcessProbe } from './e2e-process-probe.ts';

function stat(pid: number, ppid: number, name: string) {
  const fields = Array.from({ length: 50 }, () => '0');
  fields[0] = 'S';
  fields[1] = String(ppid);
  for (const field of [10, 12, 14, 15, 22, 24, 42]) fields[field - 3] = String(field * 100);
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}

test('stat の括弧や空白を含む名前と、単位の異なる計数値を読む', () => {
  assert.deepEqual(parseProcessStat(stat(123, 45, 'node (test)')), {
    pid: 123,
    ppid: 45,
    name: 'node (test)',
    state: 'S',
    minorFaults: 1000,
    majorFaults: 1200,
    userTicks: 1400,
    systemTicks: 1500,
    startTicks: 2200,
    rssPages: 2400,
    blockIoDelayTicks: 4200,
  });
  assert.throws(() => parseProcessStat('broken'));
});

test('自分の workerd と起動元だけを選び、別の実行・ブラウザ・終了済みのプロセスを混ぜない', async (t) => {
  const procRoot = await mkdtemp(join(tmpdir(), 'e2e-process-proc-'));
  t.after(() => rm(procRoot, { recursive: true, force: true }));
  for (const [pid, ppid, name] of [
    [10, 1, 'node'],
    [20, 10, 'node'],
    [30, 20, 'workerd'],
    [40, 10, 'chrome'],
    [50, 1, 'workerd'],
    [60, 70, 'workerd'],
    [70, 60, 'node'], // 親の循環も抜ける
  ] as const) {
    await mkdir(`${procRoot}/${pid}`);
    await writeFile(`${procRoot}/${pid}/stat`, stat(pid, ppid, name));
  }
  await mkdir(`${procRoot}/80`); // stat を読む前に消えたプロセス
  await mkdir(`${procRoot}/90`);
  await writeFile(`${procRoot}/90/stat`, '壊れた stat');
  await writeFile(`${procRoot}/30/schedstat`, '123 456 7\n');
  await writeFile(`${procRoot}/30/wchan`, 'ep_poll');
  await writeFile(`${procRoot}/30/io`, 'read_bytes: 8192\nwrite_bytes: 4096\n');
  const sample = await sampleProcesses(10, procRoot);
  assert.deepEqual(
    sample.processes.map(({ pid }) => pid),
    [10, 20, 30],
  );
  assert.equal(sample.processes[2].mainThreadSchedstat, '123 456 7');
  assert.equal(sample.processes[2].mainThreadWchan, 'ep_poll');
  assert.equal(sample.processes[2].io, 'read_bytes: 8192\nwrite_bytes: 4096');
  assert.equal(sample.processes[0].io, null);
  assert.ok(Date.parse(sample.finishedAt) >= Date.parse(sample.startedAt));
  await rm(`${procRoot}/30`, { recursive: true });
  assert.deepEqual((await sampleProcesses(10, procRoot)).processes, []);
});

test('無効ならファイルにも procfs にも触れない', async () => {
  const probe = startProcessProbe({
    enabled: false,
    sample: async () => assert.fail('採取しない'),
    warn: () => assert.fail('警告しない'),
  });
  await probe.stop();
});

test(
  'Linux の実際の procfs で子プロセスの系統と計数値を採取できる',
  { skip: process.platform !== 'linux', timeout: 5_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ['-e', "process.title = 'workerd'; process.send('ready'); setInterval(() => {}, 1000)"],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    t.after(async () => {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    });
    await once(child, 'message');
    const sample = await sampleProcesses(process.pid);
    assert.ok(sample.processes.some(({ pid }) => pid === process.pid));
    const recorded = sample.processes.find(({ pid }) => pid === child.pid);
    assert.ok(recorded);
    assert.equal(recorded.ppid, process.pid);
    assert.equal(recorded.name, 'workerd');
    assert.ok(recorded.startTicks > 0);
    // カーネル設定や sandbox により追加項目が無い環境でも、採取本体と同じく null を許容する。
    // 読める環境では値の検査を残し、常に null を返す退行も見逃さない。
    const schedstat = await readFile(`/proc/${child.pid}/schedstat`, 'utf8').catch(() => null);
    const io = await readFile(`/proc/${child.pid}/io`, 'utf8').catch(() => null);
    if (schedstat === null) assert.equal(recorded.mainThreadSchedstat, null);
    else assert.match(recorded.mainThreadSchedstat!, /^\d+ \d+ \d+$/);
    if (io === null) assert.equal(recorded.io, null);
    else assert.match(recorded.io!, /read_bytes: \d+/);
  },
);

test('行を逐次保存して件数の上限で止まり、stop は待ちを中断して採取中の書き込みを待つ', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'e2e-process-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'nested', 'samples.jsonl');
  const warnings: string[] = [];
  const empty = { startedAt: '2026-11-10T16:06:37.000Z', finishedAt: '2026-11-10T16:06:37.001Z', processes: [] };
  const capped = Promise.withResolvers<void>();
  const probe = startProcessProbe({
    enabled: true,
    path,
    intervalMs: 0,
    maxSamples: 2,
    sample: async () => empty,
    warn: (message) => {
      warnings.push(message);
      capped.resolve();
    },
  });
  await capped.promise;
  await probe.stop();
  assert.deepEqual(
    (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [empty, empty],
  );
  assert.equal(warnings.length, 1);

  const sampling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stopping = startProcessProbe({
    enabled: true,
    path,
    intervalMs: 60_000,
    sample: async () => {
      sampling.resolve();
      await release.promise;
      return empty;
    },
    warn: () => assert.fail('正常終了で警告しない'),
  });
  await sampling.promise;
  const stopped = stopping.stop();
  release.resolve();
  await stopped;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), empty);
  assert.deepEqual(await readdir(join(root, 'nested')), ['samples.jsonl']);
});

test('採取と出力先の失敗は一度だけ通知し、e2e の終了を失敗させない', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'e2e-process-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const outputFailure of [false, true]) {
    const warned = Promise.withResolvers<void>();
    const warnings: string[] = [];
    const probe = startProcessProbe({
      enabled: true,
      path: outputFailure ? root : join(root, 'samples.jsonl'),
      sample: async () => {
        throw new Error('秘密の本文');
      },
      warn: (message) => {
        warnings.push(message);
        warned.resolve();
      },
    });
    await warned.promise;
    await probe.stop();
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith('[e2e-process] 記録できなかった: '));
    assert.ok(!warnings[0].includes('秘密の本文'));
  }
});
