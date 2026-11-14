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
  waitFor: (operation: T) => boolean = () => true,
) {
  const started = now();
  const blocking: Promise<ReadResponse>[] = [];
  const firstRead = parallelRead(operations, reverse, (operation) => {
    const response = read(operation);
    if (waitFor(operation)) blocking.push(response);
    return response;
  });
  const followingRead = Promise.all(blocking).then(() => parallelRead(after, reverse, read));
  const [first, following] = await Promise.all([firstRead, followingRead]);
  const responses = [...first, ...following];
  const timings = responses.map(({ ms, finishedAt, secondary }) => ({
    ms,
    secondary,
    completedMs: finishedAt - started,
  }));
  for (const response of responses) response.validate(response.body);
  return timings;
}
