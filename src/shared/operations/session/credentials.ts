// 設定から、今のセッションと同時刻以前のほかのセッションとすべての API トークンを無効にする（docs/development.md の「API トークン」）。
// 画面のセッション（Cookie）だけが使える。トークンで呼ばせると、盗まれたトークンが自分の後継を残せるため
import { z } from 'zod';
import { defineOperation } from '../define.ts';

export const credentialsRevokeAll = defineOperation({
  name: 'credentials-revoke-all',
  description:
    '今のセッションと同時刻以前に作られたほかのセッションと、取り消していないすべての API トークンを無効にする。今のセッションと、それより後に作られたセッションは残る。疑わしいときはログインし直してから実行する。再認証は求めない。応答は消したセッションの数と取り消したトークンの数で、期限内のものだけを数える。期限切れのものも消す・取り消す',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({}),
  output: z.object({ revoked_sessions: z.number().int(), revoked_tokens: z.number().int() }),
});
