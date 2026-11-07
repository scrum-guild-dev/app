import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { CONNECTION_SCOPES_MAX, connectionIdInput, connectionSchema } from './connection.ts';

// 取り込む範囲を置き換える。登録した本人だけ。入力は取り込み元の ID だけで、名前はサーバーが取り込み元の候補から引く
// （候補に無い ID は 400）。scope_mode は include に固定する。閉じたワークスペースでは 409 の workspace_closed
export const connectionScopesSave = defineOperation({
  name: 'connection-scopes-save',
  description: '接続の取り込む範囲（対象に挙げるもの）を、選んだ取り込み元の ID の一覧で置き換える。登録した本人だけ',
  mode: 'write',
  permission: 'member',
  workspace: true,
  rateLimit: { max: 20, windowSeconds: 300 },
  input: connectionIdInput.extend({ source_ids: z.array(idSchema).max(CONNECTION_SCOPES_MAX) }),
  output: z.object({ connection: connectionSchema }),
});
