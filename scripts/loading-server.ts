import { isHealth } from '../src/shared/health.ts';
import type { ChildProcess } from 'node:child_process';
export function isBenchHealth(value: unknown, version: string): boolean {
  return isHealth(value) && value.version === version;
}
// 起動直後から close を待つ。シグナル終了済みの子に exit を再登録して待ち続けない。
export function trackServer(child: ChildProcess, processGroup = false) {
  // detached で起動した自分のグループだけを止める。親が先に終了しても孫を残さない。
  const signal = (value: NodeJS.Signals) => {
    try {
      if (processGroup && child.pid !== undefined) process.kill(-child.pid, value);
      else if (child.exitCode === null && child.signalCode === null) child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let failure: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      failure = error;
      resolve();
    });
    child.once('close', () => resolve());
  });
  return {
    get stopped() {
      return failure !== undefined || child.exitCode !== null || child.signalCode !== null;
    },
    interrupt() {
      signal('SIGTERM');
    },
    async stop() {
      signal('SIGTERM');
      const timer = setTimeout(() => signal('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
        if (processGroup) signal('SIGKILL');
      }
    },
  };
}
