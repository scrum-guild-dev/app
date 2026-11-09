// 添付ファイルの操作の定義
import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { shortTextProblem } from '../../text-rules.ts';
import { defineOperation, type AnyOperationDefinition } from '../define.ts';

// ファイル名は前後の空白を除いて 1〜255 字。字数はコードポイントで数える
export const ATTACHMENT_FILE_NAME_MAX_LENGTH = 255;

// 1ファイルの上限（50MB）。attachments.size_bytes の CHECK と同じ値
export const ATTACHMENT_MAX_BYTES = 52_428_800;

const fileNameSchema = z
  .string()
  // 片割れのサロゲートは UTF-8 にできず、R2 のヘッダーや D1 で U+FFFD に置き換わって応答と行が食い違う。
  .refine((name) => name.isWellFormed(), { message: 'ファイル名が使えない（片割れのサロゲート）' })
  // trim() が BOM などの禁止文字まで落とす前に検査する。長さは空白を除いた後で数える。
  .superRefine((name, ctx) => {
    const problem = shortTextProblem(name, Infinity);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `ファイル名が使えない（${problem}）` });
  })
  .trim()
  .superRefine((name, ctx) => {
    const problem = shortTextProblem(name, ATTACHMENT_FILE_NAME_MAX_LENGTH);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `ファイル名が使えない（${problem}）` });
  });

export const attachmentUpload = defineOperation({
  name: 'attachment-upload',
  description:
    '添付ファイルを上げる。本文はファイルのバイト、入力の JSON はヘッダー X-Operation-Input。付く先のない行を作り、種類は先頭のバイトで決める',
  permission: 'member',
  workspace: true,
  mode: 'write',
  body: 'binary',
  // 仮の蓋。組織の合計の上限（#68 のストーリー E）と付く先のない行の掃除（#746）が入るまで、1人が R2 に積む速さを抑える
  rateLimit: { max: 60, windowSeconds: 600 },
  input: z.object({ workspace_id: idSchema, file_name: fileNameSchema }),
  output: z.object({
    id: z.string(),
    file_name: z.string(),
    content_type: z.string(),
    size_bytes: z.number(),
    created_at: z.string(),
  }),
});

export const attachmentDownload = defineOperation({
  name: 'attachments',
  description: '未添付のファイルを、上げた本人の権限を確かめて返す',
  permission: 'organization',
  mode: 'read',
  response: 'binary',
  input: z.object({ id: idSchema }),
  output: z.instanceof(Response),
});

export const ATTACHMENT_LIST_PAGE_SIZE = 50;
const attachmentListCursor = z.object({ created_at: z.iso.datetime(), id: idSchema });

export const attachmentList = defineOperation({
  name: 'attachment-list',
  description: 'タスクに付いたファイルを上げた日時と ID の順で50件ずつ返す',
  permission: 'member',
  workspace: true,
  mode: 'read',
  input: z.object({ workspace_id: idSchema, task_id: idSchema, after: attachmentListCursor.optional() }),
  output: z.object({
    next_cursor: attachmentListCursor.optional(),
    attachments: z.array(
      z.object({
        id: z.string(),
        file_name: z.string(),
        content_type: z.string(),
        size_bytes: z.number(),
        created_at: z.string(),
        uploaded_by: z.string().nullable(),
        uploaded_by_name: z.string().nullable(),
        deletable: z.boolean(),
      }),
    ),
  }),
});

export const attachmentDelete = defineOperation({
  name: 'attachment-delete',
  storage: 'attachments',
  description: 'タスクの添付ファイルを上げた人かリーダーが消す',
  permission: 'member',
  workspace: true,
  mode: 'write',
  input: z.object({ workspace_id: idSchema, task_id: idSchema, attachment_id: idSchema }),
  output: z.object({ id: z.string() }),
});

export const attachmentOperations: readonly AnyOperationDefinition[] = [
  attachmentUpload,
  attachmentDownload,
  attachmentList,
  attachmentDelete,
];
