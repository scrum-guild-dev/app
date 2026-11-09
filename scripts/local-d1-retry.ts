import { setTimeout } from 'node:timers/promises';

type Result = { status: number | null; error?: Error; stderr?: string | null };

// 起動済みの preview とローカル D1 を共有する seed 用。SQL の誤りや起動失敗は隠さない。
// 呼び出し側は同じ操作を繰り返せるもの（migrations apply、表の一覧、seed の入れ直し）に限る。
export async function retryLocalD1<T extends Result>(
  run: () => T,
  wait: (ms: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const result = run();
    if (
      result.status === null ||
      result.status === 0 ||
      result.error ||
      !/\bSQLITE_BUSY\b/.test(result.stderr ?? '') ||
      attempt === 2
    ) {
      return result;
    }
    console.error(`ローカル D1 がロックされています。再試行します（${attempt + 1}/2）`);
    await wait(500 * (attempt + 1));
  }
}
