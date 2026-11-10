// 添付ファイルの操作の処理（定義は src/shared/operations/attachment/index.ts）
import { now } from '../../shared/clock.ts';
import { attachmentDownload, attachmentUpload } from '../../shared/operations/attachment/index.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, throwIfClosed } from './write-guards.ts';
import { insertUploadedAttachment, attachmentFitsQuota } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { sniffContentType } from '../attachments/sniff.ts';
import { downloadAttachment } from '../attachments/download.ts';

export const attachmentDownloadOperation = implement(attachmentDownload, async ({ db, actor, input, download }) => {
  if (actor.userId === null) throw new ApiError(404, 'not_found');
  const userId = actor.userId;
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('attachments as a')
        .innerJoin('workspaces as w', 'w.id', 'a.workspace_id')
        .select(['a.id', 'a.workspace_id', 'a.object_key', 'a.file_name', 'a.content_type'])
        .where('w.organization_id', '=', db.organizationId)
        .where('a.id', '=', input.id)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('a.uploaded_by', '=', userId),
              eb('a.attached_at', 'is', null),
              eb('a.task_id', 'is', null),
              eb('a.story_id', 'is', null),
              eb('a.epic_id', 'is', null),
              eb('a.comment_id', 'is', null),
            ]),
            eb.and([
              eb('a.attached_at', 'is not', null),
              eb('a.story_id', 'is', null),
              eb('a.epic_id', 'is', null),
              eb.or([
                eb.exists(
                  eb
                    .selectFrom('tasks as t')
                    .select('t.id')
                    .whereRef('t.id', '=', 'a.task_id')
                    .whereRef('t.workspace_id', '=', 'a.workspace_id')
                    .where('t.deleted_at', 'is', null),
                ),
                eb.exists(
                  eb
                    .selectFrom('comments as c')
                    .innerJoin('tasks as t', 't.id', 'c.task_id')
                    .select('c.id')
                    .whereRef('c.id', '=', 'a.comment_id')
                    .whereRef('c.workspace_id', '=', 'a.workspace_id')
                    .whereRef('t.workspace_id', '=', 'a.workspace_id')
                    .where('c.deleted_at', 'is', null)
                    .where('t.deleted_at', 'is', null),
                ),
              ]),
            ]),
          ]),
        )
        .where((eb) =>
          actor.isAdmin
            ? eb.val(true)
            : eb.exists(
                eb
                  .selectFrom('memberships as m')
                  .select('m.id')
                  .whereRef('m.workspace_id', '=', 'a.workspace_id')
                  .where('m.user_id', '=', userId)
                  .where('m.left_at', 'is', null),
              ),
        ),
    ),
  );
  // 未添付は本人だけ。確定した添付は、削除されていないタスクかコメントを今読める人だけ。
  if (row === undefined || row.object_key !== `${db.organizationId}/${row.workspace_id}/${row.id}`) {
    throw new ApiError(404, 'not_found');
  }
  const response = await downloadAttachment(download.bucket, row, download);
  if (response === null) throw new ApiError(404, 'not_found');
  return response;
});

export const attachmentUploadOperation = implement(
  attachmentUpload,
  async ({ db, workspace, actor, tools, input, binary, requestId }) => {
    // R2 に書く前に閉じる（書いた後の NOT NULL 違反で、消すだけの書き込みをしない）
    const uploadedBy = actorUserIdOf(actor);
    const { attachmentQuotaBytes, attachmentQuotaNeedsCheck } = await tools.readOrganization();
    if (
      binary.contentLength > attachmentQuotaBytes ||
      (attachmentQuotaNeedsCheck && !(await attachmentFitsQuota(db, attachmentQuotaBytes, binary.contentLength)))
    ) {
      await throwIfClosed(db, workspace.workspaceId);
      throw new ApiError(409, 'attachment_quota_exceeded');
    }
    const id = uuidv7(now());
    const objectKey = `${db.organizationId}/${workspace.workspaceId}/${id}`;
    let createdAt: string;
    const { head, stream } = await peekHead(binary.body);
    const contentType = sniffContentType(head);
    const fixed = new FixedLengthStream(binary.contentLength);
    const abort = new AbortController();
    const pumping = stream.pipeTo(fixed.writable, { signal: abort.signal });
    const putting = binary.bucket.put(objectKey, fixed.readable, { httpMetadata: { contentType } });
    // put が先に失敗すると fixed.readable を読む側がいなくなり、pipeTo が決着しない。流すのを止めて決着させる
    putting.catch(() => abort.abort());
    try {
      // R2 は JS の ReadableStream の長さを知らない。FixedLengthStream で長さを伝え、実際のバイト数も確かめる。
      // 送る側が先に失敗しても put の決着を待つ（待たずに消すと、後から put が確定してファイルが残りうる）
      const [pumped, put] = await Promise.allSettled([pumping, putting]);
      // put の失敗を先に見る。put が失敗すると putting.catch が流し込みを止め、pumping は AbortError になるので、原因は put の側
      if (put.status === 'rejected') throw put.reason;
      if (pumped.status === 'rejected') throw pumped.reason;
      // 上げ終えた時刻にする。付く先のない行の掃除（#746）は created_at の古さで消すので、上げ始めの時刻にしない
      createdAt = now().toISOString();
      const inserted = await insertUploadedAttachment(
        db,
        {
          id,
          workspaceId: workspace.workspaceId,
          objectKey,
          fileName: input.file_name,
          contentType,
          sizeBytes: binary.contentLength,
          userId: uploadedBy,
          at: createdAt,
        },
        attachmentQuotaBytes,
      );
      if (!inserted) {
        await throwIfClosed(db, workspace.workspaceId);
        // 初回の容量拒否でも、次の要求を本文/R2より前の確認へ回す。失敗の応答では重い処理を起動しない。
        await tools.reconcileAttachmentQuota({ markOnly: true });
        throw new ApiError(409, 'attachment_quota_exceeded');
      }
    } catch (error) {
      abort.abort();
      await Promise.allSettled([pumping, putting]);
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
      if (error instanceof ApiError) throw error;
      // どこで落ちたか（R2、長さの食い違い、D1 の制約）を追えるよう、例外の名前だけを残す（メッセージはキーを含みうる）
      console.error(
        JSON.stringify({
          level: 'error',
          code: 'internal',
          requestId,
          reason: '添付ファイルを保存できなかった',
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
      throw new Error('添付ファイルの保存に失敗した', { cause: error });
    }
    await tools.reconcileAttachmentQuota();
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
