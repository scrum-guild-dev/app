import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { WORKSPACE_LIMITS } from '../../organization-kind.ts';
import { timezoneSchema } from '../../timezone.ts';
import { workspaceNameSchema } from '../../workspace.ts';
import { defineOperation } from '../define.ts';

// 作ると同時に、既定の列、決まった欄、換算比率、最初のリーダーの所属を書く（1回の batch）。
// 最初のリーダーは、いまこの組織に入れる、無効でなく login_subject のあるユーザー（workspace-leader-candidates が返す人）。
// 管理者自身を指したときだけ所属ができる。指さないときは、作った管理者の memberships の行を作らない。
// timezone は検証のときに正規の名前（asia/tokyo は Asia/Tokyo）にそろう。
// 自分用の組織（kind が personal）は、利用中を WORKSPACE_LIMITS.personal の個数までしか作れない。
// 上限なら何も書かずに 409 の workspace_limit_reached（details は { used, limit }）。確かめは書く文の条件にも入れ、同時の作成でも超えない。
// チーム用の組織の個数は制限しない。終了すると枠が空き、開き直し（workspace-reopen）にも空き枠が必要
export const workspaceCreate = defineOperation({
  name: 'workspace-create',
  description: `ワークスペースを作る。名前、タイムゾーン、最初のリーダーを指す。既定の列、決まった欄、換算比率（1ポイント = 4時間）、週の始まり（月曜）も同時に入れる。自分用の組織は、利用中が${WORKSPACE_LIMITS.personal}個まで。終了すると枠が空く。上限なら 409 の workspace_limit_reached（details は { used, limit }）`,
  mode: 'write',
  permission: 'admin',
  input: z.object({
    name: workspaceNameSchema,
    timezone: timezoneSchema,
    leader_user_id: idSchema,
  }),
  output: z.object({ workspace_id: z.string() }),
});
