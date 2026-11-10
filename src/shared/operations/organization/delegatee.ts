import { z } from 'zod';
import { definitionNameSchema } from '../../definition.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 区分と同じく、一覧を1回で返せる数に限る。削除済みは数えない。
export const DELEGATEES_PER_ORGANIZATION = 50;

export const delegateeSchema = z.object({ id: z.string(), name: z.string() });

export const delegateeList = defineOperation({
  name: 'delegatee-list',
  description: '組織の依頼先の名簿を名前の順に返す。削除した人は返さない',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({ delegatees: z.array(delegateeSchema).max(DELEGATEES_PER_ORGANIZATION) }),
});

export const delegateeCreate = defineOperation({
  name: 'delegatee-create',
  description: '自分用の組織の依頼先の名簿に人を足す。同じ名前は登録できない',
  mode: 'write',
  permission: 'admin',
  input: z.object({ name: definitionNameSchema }),
  output: z.object({ delegatee: delegateeSchema }),
});

export const delegateeUpdate = defineOperation({
  name: 'delegatee-update',
  description: '自分用の組織の依頼先の名前を変える。同じ名前は登録できない',
  mode: 'write',
  permission: 'admin',
  input: z.object({ delegatee_id: idSchema, name: definitionNameSchema }),
  output: z.object({ delegatee: delegateeSchema }),
});

export const delegateeDelete = defineOperation({
  name: 'delegatee-delete',
  description: '自分用の組織の依頼先を削除し、未完了のタスクから外す。完了したタスクの依頼先は残す',
  mode: 'write',
  permission: 'admin',
  input: z.object({ delegatee_id: idSchema }),
  output: z.object({ delegatee_id: z.string() }),
});
