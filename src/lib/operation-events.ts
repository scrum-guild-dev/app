// 成功した画面の書き込みを、関連する読み取りだけへ伝える。応答を待たせない。
export type OperationWrite = { name: string; slug: string };
const listeners = new Set<(event: OperationWrite) => void>();
export function onOperationWrite(listener: (event: OperationWrite) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function notifyOperationWrite(event: OperationWrite): void {
  for (const listener of listeners) {
    // 保存成功の通知先の失敗で、済んだ書き込みを失敗扱いにしない。
    try {
      listener(event);
    } catch {
      /* 各購読側が復旧する。 */
    }
  }
}
