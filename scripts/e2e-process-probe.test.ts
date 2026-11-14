import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  identifyD1File,
  parseIoSyscall,
  parseProcessStat,
  sampleIoWait,
  sampleProcesses,
  startProcessProbe,
} from './e2e-process-probe.ts';

const syscallLine = (number: number, fd = '0x7') => `${number} ${fd} 0x123 0x456 0x0 0x0 0x0 0x789 0xabc\n`;

test('syscall の ABI を区別し、引数とアドレスを出力しない', () => {
  for (const [arch, number, name] of [
    ['x64', 74, 'fsync'],
    ['x64', 75, 'fdatasync'],
    ['x64', 18, 'pwrite64'],
    ['arm64', 82, 'fsync'],
    ['arm64', 83, 'fdatasync'],
    ['arm64', 68, 'pwrite64'],
  ] as const) {
    assert.deepEqual(parseIoSyscall(syscallLine(number), arch), { status: 'io', number, name, fd: 7 });
  }
  assert.deepEqual(parseIoSyscall(syscallLine(74), 'arm64'), { status: 'other', number: 74 });
  assert.deepEqual(parseIoSyscall(syscallLine(74), 'riscv64'), { status: 'unsupported-arch' });
  assert.deepEqual(parseIoSyscall('running', 'x64'), { status: 'running' });
  assert.deepEqual(parseIoSyscall('-1 0x123 0x456', 'x64'), { status: 'userspace' });
  for (const line of ['秘密', '74 0x7', syscallLine(74, '秘密'), syscallLine(74, '0xffffffffffffffff')]) {
    assert.deepEqual(parseIoSyscall(line, 'x64'), { status: 'invalid' });
  }
});

test('既知の D1 ファイル以外のパスや名前は残さない', () => {
  const relative = `v3/d1/miniflare-D1DatabaseObject/${'a'.repeat(64)}.sqlite`;
  for (const root of ['/workspace/app/.wrangler/state', '/dev/shm/scrum-guild-wrangler-state']) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      assert.equal(identifyD1File(`${root}/${relative}${suffix}`), relative + suffix);
    }
  }
  for (const path of [
    '/秘密/.env',
    '/tmp/秘密.sqlite',
    `/tmp/${relative}`,
    `/workspace/.wrangler/state/${relative}/秘密`,
    '/proc/self/fd/7',
  ]) {
    assert.equal(identifyD1File(path), null);
  }
});

test('syscall と fd を対応付け、読めない場合と PID が変わった場合を区別する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'e2e-syscall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(`${root}/30/fd`, { recursive: true });
  assert.equal((await sampleIoWait(30, 2200, root)).status, 'unavailable');
  const relative = `v3/d1/miniflare-D1DatabaseObject/${'b'.repeat(64)}.sqlite-wal`;
  await writeFile(`${root}/30/syscall`, syscallLine(process.arch === 'arm64' ? 82 : 74));
  await writeFile(`${root}/30/stat`, stat(30, 10, 'workerd'));
  await symlink(`/dev/shm/scrum-guild-wrangler-state/${relative}`, `${root}/30/fd/7`);
  const sampled = await sampleIoWait(30, 2200, root);
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    assert.equal(sampled.status, 'unsupported-arch');
    return;
  }
  assert.equal(sampled.status, 'io');
  assert.ok('file' in sampled);
  assert.equal(sampled.file, relative);
  assert.equal(sampled.fileStatus, 'd1');
  assert.equal((await sampleIoWait(30, 9999, root)).status, 'changed');
  await rm(`${root}/30/fd/7`);
  await symlink('/秘密/.env', `${root}/30/fd/7`);
  const redacted = await sampleIoWait(30, 2200, root);
  assert.ok('file' in redacted);
  assert.equal(redacted.file, null);
  assert.equal(redacted.fileStatus, 'outside-allowlist');
  assert.ok(!JSON.stringify(redacted).includes('秘密'));
  await rm(`${root}/30/fd/7`);
  const missing = await sampleIoWait(30, 2200, root);
  assert.ok('file' in missing);
  assert.equal(missing.fileStatus, 'unavailable');
});

function stat(pid: number, ppid: number, name: string) {
  const fields = Array.from({ length: 50 }, () => '0');
  fields[0] = 'S';
  fields[1] = String(ppid);
  for (const field of [10, 12, 14, 15, 22, 24, 42]) fields[field - 3] = String(field * 100);
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}

test(
  '採取途中の syscall 変更や取得失敗はファイルとの対応を捨てる',
  { skip: !['x64', 'arm64'].includes(process.arch) },
  async () => {
    const before = syscallLine(process.arch === 'arm64' ? 82 : 74);
    for (const after of [syscallLine(process.arch === 'arm64' ? 83 : 75), null]) {
      let count = 0;
      const sampled = await sampleIoWait(30, 2200, '/not-a-proc', async (path) => {
        if (path.endsWith('/stat')) return stat(30, 10, 'workerd');
        return count++ === 0 ? before : after;
      });
      assert.equal(count, 2);
      assert.equal(sampled.status, 'changed');
      assert.ok(!('file' in sampled));
      assert.ok(!('fd' in sampled));
    }
  },
);

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
  '実 procfs の read 待ちを sampleProcesses 経由で採り、生の引数やパスは残さない',
  { skip: process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch), timeout: 5_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.title = 'workerd'; process.send('ready', () => { require('node:fs').readSync(0, Buffer.alloc(1), 0, 1, null); });",
      ],
      { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] },
    );
    t.after(async () => {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    });
    await once(child, 'message');
    // カーネル/sandbox が syscall を拒む場合も、常に null を返す退行は見逃さない。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const sample = await sampleProcesses(process.pid);
      const io = sample.processes.find(({ pid }) => pid === child.pid)?.mainThreadIo;
      assert.ok(io);
      if (io.status === 'unavailable') {
        assert.equal(await readFile(`/proc/${child.pid}/syscall`, 'utf8').catch(() => null), null);
        return;
      }
      if (io.status === 'io' && io.name === 'read' && io.fd === 0) {
        assert.equal(io.file, null);
        assert.equal(io.fileStatus, 'outside-allowlist');
        return;
      }
    }
    assert.fail('子プロセスの read(0) 待ちを採取できなかった');
  },
);

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
