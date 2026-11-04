import { z } from 'zod';
import { idSchema } from './id.ts';

export const ATTACHMENTS_PER_SAVE = 20;
export const attachmentIdsSchema = z
  .array(idSchema)
  .max(ATTACHMENTS_PER_SAVE)
  .refine((ids) => new Set(ids).size === ids.length, '添付の ID は重ねられません');
