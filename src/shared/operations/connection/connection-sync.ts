import { z } from 'zod';
import { defineOperation } from '../define.ts';
import { connectionIdInput, connectionSchema } from './connection.ts';

// 「今すぐ同期」を、押した場で終わらせる。登録した本人だけ。接続ごとに5分に1回（connections.last_manual_sync_at の条件つきの更新）と、
// アカウントと操作ごとの回数の上限（rateLimit）の両方で断る。5分以内は 429、止まっている接続は 409（connection_stopped）、
// 閉じたワークスペースは 409 の workspace_closed。同期の結果は 200 で返す（imported: 今回届いた件数、more: 上限で止めて続きは次の同期、
// result: 範囲が空で何も問い合わせなかった no_scope、認証が通らず接続を停止にした auth_failed、取り込み元の不調で失敗した error）
export const SYNC_RESULTS = ['success', 'no_scope', 'auth_failed', 'error'] as const;
export const CONNECTION_MANUAL_SYNC_INTERVAL_SECONDS = 300;

export const connectionSync = defineOperation({
  name: 'connection-sync',
  description:
    '接続を今すぐ同期する。自分が登録した接続だけ、接続ごとに5分に1回まで。届いた件数と、上限で止めたかを返す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  rateLimit: { max: 20, windowSeconds: 300 },
  input: connectionIdInput,
  output: z.object({
    result: z.enum(SYNC_RESULTS),
    imported: z.number().int().min(0),
    more: z.boolean(),
    connection: connectionSchema,
  }),
});
