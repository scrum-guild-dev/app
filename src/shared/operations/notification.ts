import { z } from 'zod';
import { idSchema } from '../id.ts';
import { defineOperation } from './define.ts';

const cursor = z.object({ created_at: z.iso.datetime({ precision: 3 }), id: idSchema });

export const notificationList = defineOperation({
  name: 'notification-list',
  description: 'この組織の自分宛ての通知を新しい順に50件読む。未読だけで絞れ、続きのカーソルと未読の総数を返す',
  mode: 'read',
  permission: 'organization',
  input: z.object({ unread_only: z.boolean().optional(), before: cursor.optional() }),
  output: z.object({
    notifications: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        payload: z.object({ used_bytes: z.number().nonnegative(), quota_bytes: z.number().positive() }),
        read_at: z.string().nullable(),
        created_at: z.string(),
      }),
    ),
    next: cursor.nullable(),
    unread_count: z.number().int().nonnegative(),
  }),
});

export const notificationRead = defineOperation({
  name: 'notification-read',
  description: 'この組織の自分宛ての通知を既読にする。すでに既読なら元の日時を返す。他人と別組織の通知は404',
  mode: 'write',
  permission: 'organization',
  input: z.object({ id: idSchema }),
  output: z.object({ id: z.string(), read_at: z.string() }),
});
