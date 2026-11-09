// 発行する順だけを替える。結果は元の操作表の順へ戻し、操作名と時間がずれないようにする。
export async function parallelRead<T, R>(
  values: readonly T[],
  reverse: boolean,
  read: (value: T) => Promise<R>,
): Promise<R[]> {
  const indexed = values.map((value, index) => ({ value, index }));
  if (reverse) indexed.reverse();
  const results = await Promise.all(indexed.map(async ({ value, index }) => ({ index, result: await read(value) })));
  return results.sort((a, b) => a.index - b.index).map(({ result }) => result);
}
