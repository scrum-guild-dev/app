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
  input: z.object({ workspace_id: idSchema, file_name: fileNameSchema }),
  output: z.object({
    id: z.string(),
    file_name: z.string(),
    content_type: z.string(),
    size_bytes: z.number(),
    created_at: z.string(),
  }),
});

export const attachmentOperations: readonly AnyOperationDefinition[] = [attachmentUpload];
