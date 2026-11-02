// 添付ファイルの操作の処理（定義は src/shared/operations/attachment/index.ts）
import { attachmentUpload } from '../../shared/operations/attachment/index.ts';
import { implement } from './implement.ts';

export const attachmentUploadOperation = implement(attachmentUpload, async () => {
  throw new Error('未実装');
});
