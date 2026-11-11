// #1149: HTTP の遅れと、workerd・起動元の CPU / I/O / 実行待ちを突き合わせるための一時的な記録。
// Linux の CI だけで使う。コマンドライン・環境変数・ファイルの内容は記録しない。
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const PROCESS_SAMPLE_PATH = 'test-results/e2e-process-samples.jsonl';
const INTERVAL_MS = 500;
// 30 分相当で打ち切る。HTTP の記録と異なり、正常時も比較用に残す。
const MAX_SAMPLES = 3_600;

export function parseProcessStat(text: string) {
  // comm は空白や括弧を含みうる。最後の閉じ括弧より後が stat の第3フィールド以降。
  const end = text.lastIndexOf(')');
  const start = text.indexOf('(');
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (start < 0 || end < start || fields.length < 40) throw new Error('invalid proc stat');
  const value = (field: number) => {
    const result = Number(fields[field - 3]);
    if (!Number.isFinite(result)) throw new Error('invalid proc stat field');
    return result;
  };
  return {
    pid: Number(text.slice(0, start).trim()),
    name: text.slice(start + 1, end),
    state: fields[0],
    ppid: value(4),
    minorFaults: value(10),
    majorFaults: value(12),
    userTicks: value(14),
    systemTicks: value(15),
    startTicks: value(22),
    rssPages: value(24),
    blockIoDelayTicks: value(42),
  };
}

// プロセスの終了や権限不足で読めなかった項目は null。0（待ちが無い）と区別する。
async function optionalRead(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

export async function sampleProcesses(rootPid: number, procRoot = '/proc') {
  const startedAt = new Date().toISOString();
  const entries = await readdir(procRoot);
  const stats = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const stat = await optionalRead(`${procRoot}/${entry}/stat`);
        if (stat === null) return null;
        try {
          return parseProcessStat(stat);
        } catch {
          return null;
        }
      }),
  );
  const processes = new Map(stats.filter((stat) => stat !== null).map((stat) => [stat.pid, stat]));
  const selected = new Set<number>();
  for (const stat of processes.values()) {
    if (stat.name !== 'workerd') continue;
    const lineage = new Set<number>();
    let current: typeof stat | undefined = stat;
    while (current && !lineage.has(current.pid)) {
      lineage.add(current.pid);
      if (current.pid === rootPid) {
        for (const pid of lineage) selected.add(pid);
        break;
      }
      current = processes.get(current.ppid);
    }
  }
  const samples = await Promise.all(
    [...selected]
      .sort((a, b) => a - b)
      .map(async (pid) => {
        const [schedstat, io, wchan] = await Promise.all(
          ['schedstat', 'io', 'wchan'].map((name) => optionalRead(`${procRoot}/${pid}/${name}`)),
        );
        return {
          ...processes.get(pid)!,
          // schedstat と wchan は主スレッドだけ。プロセス全体の CPU は上の stat。
          mainThreadSchedstat: schedstat?.trim() ?? null,
          mainThreadWchan: wchan?.trim() ?? null,
          io: io?.trim() ?? null,
        };
      }),
  );
  return { startedAt, finishedAt: new Date().toISOString(), processes: samples };
}

export type ProcessProbeOptions = {
  enabled: boolean;
  rootPid: number;
  path: string;
  sample: typeof sampleProcesses;
  intervalMs: number;
  maxSamples: number;
  warn: (message: string) => void;
};

// 逐次書き出すので、途中でジョブが切られても採取済みの行は既存の CI 成果物に残る。
// 採取失敗は一度だけ通知して記録を止める。e2e 自体の成否を変えない。
export function startProcessProbe(options: Partial<ProcessProbeOptions> = {}): { stop: () => Promise<void> } {
  const { enabled, rootPid, path, sample, intervalMs, maxSamples, warn } = {
    enabled: Boolean(process.env.CI) && process.platform === 'linux',
    rootPid: process.pid,
    path: PROCESS_SAMPLE_PATH,
    sample: sampleProcesses,
    intervalMs: INTERVAL_MS,
    maxSamples: MAX_SAMPLES,
    warn: (message: string) => console.warn(message),
    ...options,
  };
  const controller = new AbortController();
  const done = (async () => {
    if (!enabled) return;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(dirname(path), { recursive: true });
      file = await open(path, 'w');
      for (let count = 0; count < maxSamples && !controller.signal.aborted; count += 1) {
        await file.writeFile(`${JSON.stringify(await sample(rootPid))}\n`);
        if (count + 1 === maxSamples) {
          warn(`[e2e-process] ${maxSamples} 件で記録を打ち切った`);
          break;
        }
        await delay(intervalMs, undefined, { signal: controller.signal }).catch(() => {});
      }
    } catch (error) {
      warn(`[e2e-process] 記録できなかった: ${error instanceof Error ? error.name : 'error'}`);
    } finally {
      await file?.close();
    }
  })();
  // close の失敗を含め、記録の reject をテスト終了まで放置しない。
  const settled = done.catch(() => {});
  return {
    stop: async () => {
      controller.abort();
      await settled;
    },
  };
}
