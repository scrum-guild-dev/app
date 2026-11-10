import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 依頼先は担当と別。担当なしに依頼先を付けると自分を担当にする。外しても担当は残し、今日やるの印は変えない。
export const taskDelegate = defineOperation({
  name: 'task-delegate',
  description: '自分用の組織の未完了のバックログのタスクに依頼先を付けるか外す。担当なしなら自分を担当にする',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema, delegatee_id: idSchema.nullable() }),
  output: z.object({ task_id: z.string() }),
});
