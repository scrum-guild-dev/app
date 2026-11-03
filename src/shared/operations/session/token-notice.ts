// API トークンの発行の知らせ。確認はアカウント全体ではなく Cookie のセッションごとに持つ。
import { z } from 'zod';
import { defineOperation } from '../define.ts';

export const tokenNotice = defineOperation({
  name: 'token-notice',
  description: '今のセッションがまだ確かめていない API トークンの発行の数と最新の1件を返す',
  mode: 'read',
  permission: 'login',
  cookieOnly: true,
  input: z.object({}),
  output: z.object({
    count: z.number().int().nonnegative(),
    latest: z
      .object({
        name: z.string(),
        scope: z.enum(['read', 'write']),
        created_at: z.string(),
        revoked: z.boolean(),
      })
      .nullable(),
  }),
});

export const tokenNoticeSeen = defineOperation({
  name: 'token-notice-seen',
  description:
    '画面に出した最新の発行までを、今のセッションだけで確かめたことにする。確認日時は戻さず最新の発行より先に進めない',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  input: z.object({ created_at: z.iso.datetime({ precision: 3 }) }),
  output: z.object({}),
});
