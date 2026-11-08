import { isHealth } from '../src/shared/health.ts';
import type { ChildProcess } from 'node:child_process';
export function isBenchHealth(value: unknown, version: string): boolean {
  return isHealth(value) && value.version === version;
}
// 起動直後から close を待つ。シグナル終了済みの子に exit を再登録して待ち続けない。
export function trackServer(child: ChildProcess) {
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
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
