// 設定から、今のセッション以外のすべてのセッションとすべての API トークンを無効にする（docs/development.md の「API トークン」）。
// 画面のセッション（Cookie）だけが使える。トークンで呼ばせると、盗まれたトークンが自分の後継を残せるため
import { z } from 'zod';
import { defineOperation } from '../define.ts';

export const credentialsRevokeAll = defineOperation({
  name: 'credentials-revoke-all',
  description:
    '今のセッション以外のすべてのセッションと、取り消していないすべての API トークンを無効にする。今のセッションは残る。再認証は求めない。応答は消したセッションの数と取り消したトークンの数',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({}),
  output: z.object({ revoked_sessions: z.number().int(), revoked_tokens: z.number().int() }),
});
