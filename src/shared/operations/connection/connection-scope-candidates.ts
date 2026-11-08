import { z } from 'zod';
import { defineOperation } from '../define.ts';
import { connectionIdInput } from './connection.ts';

// 範囲の候補。登録した本人だけが、保存した認証情報を復号して取り込み元に問い合わせる（ほかのメンバーは 403、
// 別のワークスペースと別の組織の接続は 404）。認証情報を取り込み元が受け付けなければ 409 の conflict（details.reason は credential_rejected）、
// 届かなければ 503。閉じたワークスペースでも読める
export const connectionScopeCandidates = defineOperation({
  name: 'connection-scope-candidates',
  description: '接続の認証情報で、取り込み元の範囲の候補（取り込み元の ID と名前）を返す。登録した本人だけ',
  mode: 'read',
  permission: 'member',
  workspace: true,
  rateLimit: { max: 20, windowSeconds: 300 },
  // サーバーは取り込み元への 1 回の問い合わせに 10 秒の上限を掛け、候補を読むときは何回か問い合わせうる。
  // 画面の既定（10 秒）では正常な応答も切れるので、長く待つ
  clientTimeoutMs: 30_000,
  input: connectionIdInput,
  output: z.object({ candidates: z.array(z.object({ id: z.string(), name: z.string() })) }),
});
