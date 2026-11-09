import { z } from 'zod';
import { defineOperation } from './define.ts';
import { idSchema } from '../id.ts';

const targetType = z.enum(['task', 'story', 'epic', 'wiki_page']);
export const favoriteList = defineOperation({
  name: 'favorite-list',
  description: '自分のお気に入りを読む',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({
    favorites: z.array(
      z.object({
        id: z.string(),
        target_type: targetType,
        target_id: z.string(),
        workspace_id: z.string().nullable(),
        title: z.string(),
        created_at: z.string(),
      }),
    ),
  }),
});
export const favoriteSet = defineOperation({
  name: 'favorite-set',
  description:
    '自分のお気に入りを付け外しする。対象は読めるタスク、ストーリー、エピック、Wikiのページ。付けるのは冪等。20件を超えると409のfavorite_limit（detailsは{ used, limit }）。非表示になった本人の印も外せる',
  mode: 'write',
  permission: 'organization',
  input: z.object({ target_type: targetType, target_id: idSchema, is_favorite: z.boolean() }),
  output: z.object({ is_favorite: z.boolean() }),
});
