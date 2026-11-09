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
  // サーバーは候補の頁を順に引き、60 秒の締め切りに 1 回分の問い合わせの上限（10 秒）を足した約 70 秒まで掛かりうる
  // （src/server/import/github/index.ts の LIST_DEADLINE_MS）。画面が先に切るとサーバーの 503 を待たずに「届かない」と出るので、
  // それより長く待つ
  clientTimeoutMs: 80_000,
  input: connectionIdInput,
  output: z.object({ candidates: z.array(z.object({ id: z.string(), name: z.string() })) }),
});
