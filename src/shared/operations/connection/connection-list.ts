import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { connectionSchema } from './connection.ts';

// ワークスペースの接続の一覧。ワークスペースの全員が見られる（docs/requirements.md の「取り込み」）。削除した接続は返さない。
// 暗号文と同期の状態は返さず、認証情報は末尾4文字だけ。閉じたワークスペースでも読める
export const connectionList = defineOperation({
  name: 'connection-list',
  description: 'ワークスペースの接続を、状態、最後に成功した日時、登録した人、範囲、認証情報の末尾4文字つきで返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ connections: z.array(connectionSchema) }),
});
