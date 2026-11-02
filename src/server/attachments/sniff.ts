// 添付ファイルの種類を、中身の先頭のバイト（最大 64 バイト）で決める（docs/development.md の「添付ファイルの配信」）
export function sniffContentType(head: Uint8Array): string {
  void head;
  throw new Error('未実装');
}
