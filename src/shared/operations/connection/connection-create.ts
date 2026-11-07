import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import {
  connectionCredentialSchema,
  connectionNameSchema,
  connectionProviderSchema,
  connectionSchema,
} from './connection.ts';

// 接続を登録する。メンバーが自分の認証情報で登録する。取り込み元の型が形を検査し（合わなければ取り込み元に問い合わせず 400）、
// 取り込み元で確かめ（受け付けなければ 400 で登録しない。届かなければ 503）、暗号化して、範囲なしで保存する。
// 登録した直後の範囲は対象なし（scope_mode は include）。認証情報は応答にも履歴にも出さず、末尾4文字だけを返す。
// 閉じたワークスペースでは 409 の workspace_closed
export const connectionCreate = defineOperation({
  name: 'connection-create',
  description: '取り込み元の接続を、認証情報を確かめて暗号化して登録する。範囲は選ぶまで対象なし',
  mode: 'write',
  permission: 'member',
  workspace: true,
  // 取り込み元に問い合わせる
  rateLimit: { max: 10, windowSeconds: 600 },
  input: z.object({
    workspace_id: idSchema,
    provider: connectionProviderSchema,
    name: connectionNameSchema,
    credential: connectionCredentialSchema,
  }),
  output: z.object({ connection: connectionSchema }),
});
