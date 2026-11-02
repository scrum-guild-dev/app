// 添付ファイルの操作の処理（定義は src/shared/operations/attachment/index.ts）
import { attachmentUpload } from '../../shared/operations/attachment/index.ts';
import { implement } from './implement.ts';
import { sniffContentType } from '../attachments/sniff.ts';

export const attachmentUploadOperation = implement(
  attachmentUpload,
  async ({ db, workspace, actor, input, binary, requestId }) => {
    const id = crypto.randomUUID();
    const objectKey = `${db.organizationId}/${workspace.workspaceId}/${id}`;
    const createdAt = new Date().toISOString();
    const { head, stream } = await peekHead(binary.body);
    const contentType = sniffContentType(head);
    const fixed = new FixedLengthStream(binary.contentLength);
    const abort = new AbortController();
    const pumping = stream.pipeTo(fixed.writable, { signal: abort.signal });
    try {
      // R2 は JS の ReadableStream の長さを知らない。FixedLengthStream で長さを伝え、実際のバイト数も確かめる。
      await Promise.all([pumping, binary.bucket.put(objectKey, fixed.readable, { httpMetadata: { contentType } })]);
      await db.batch([
        db.statement((q) =>
          q.insertInto('attachments').values({
            id,
            workspace_id: workspace.workspaceId,
            task_id: null,
            story_id: null,
            epic_id: null,
            comment_id: null,
            object_key: objectKey,
            file_name: input.file_name,
            content_type: contentType,
            size_bytes: binary.contentLength,
            uploaded_by: actor.userId!,
            attached_at: null,
            created_at: createdAt,
          }),
        ),
      ]);
    } catch {
      abort.abort();
      await pumping.catch(() => {});
      try {
        await binary.bucket.delete(objectKey);
      } catch {
        // キーや R2 の例外（キーを含みうる）は出さない。
        console.error(
          JSON.stringify({
            level: 'error',
            code: 'internal',
            requestId,
            reason: '添付ファイルを消せなかった',
            count: 1,
          }),
        );
      }
      throw new Error('添付ファイルの保存に失敗した');
    }
    return {
      id,
      file_name: input.file_name,
      content_type: contentType,
      size_bytes: binary.contentLength,
      created_at: createdAt,
    };
  },
);

// 最大 64 バイトだけを集め、読んだ部分も含めたストリームを返す。tee() の片側に本文全体を溜めない。
async function peekHead(body: ReadableStream<Uint8Array>): Promise<{
  head: Uint8Array;
  stream: ReadableStream<Uint8Array>;
}> {
  const reader = body.getReader();
  const buffer = new Uint8Array(64);
  let length = 0;
  let remainder: Uint8Array | undefined;
  try {
    while (length < buffer.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const taken = Math.min(value.byteLength, buffer.length - length);
      buffer.set(value.subarray(0, taken), length);
      length += taken;
      if (taken < value.byteLength) remainder = value.subarray(taken);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  }
  const head = buffer.subarray(0, length);
  let prefix: Uint8Array | undefined = head;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (prefix !== undefined) {
          if (prefix.byteLength > 0) controller.enqueue(prefix);
          prefix = undefined;
        } else if (remainder !== undefined) {
          controller.enqueue(remainder);
          remainder = undefined;
        } else {
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(value);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    },
    { highWaterMark: 0 },
  );
  return { head, stream };
}
