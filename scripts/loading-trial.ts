import { parallelRead } from './loading-order.ts';

export type ReadResponse = {
  ms: number;
  finishedAt: number;
  secondary: boolean;
  body: unknown;
  validate: (body: unknown) => void;
};

// JSONの読取完了までを測る。同期の出力検査は後続群も含む全応答の後に行う。
export async function readTrial<T>(
  operations: readonly T[],
  after: readonly T[],
  reverse: boolean,
  read: (operation: T) => Promise<ReadResponse>,
  now: () => number = () => performance.now(),
) {
  const started = now();
  const first = await parallelRead(operations, reverse, read);
  const following = await parallelRead(after, reverse, read);
  const responses = [...first, ...following];
  const timings = responses.map(({ ms, finishedAt, secondary }) => ({
    ms,
    secondary,
    completedMs: finishedAt - started,
  }));
  for (const response of responses) response.validate(response.body);
  return timings;
}
