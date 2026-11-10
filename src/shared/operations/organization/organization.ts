import { z } from 'zod';
import { organizationKinds } from '../../organization-kind.ts';
import { themes } from '../../theme.ts';
import { defineOperation } from '../define.ts';

const theme = z.enum(themes);

// 組織の枠が使う。画面の data-theme は me.theme、なければ organization.theme。
// 読む操作だが、呼ぶと、この組織に最後に入った日時（users.last_seen_at）を1時間に1回まで書く。
// この書き込みは応答を待たせず、失敗しても応答は返す
export const organizationInfo = defineOperation({
  name: 'organization',
  description:
    '組織の名前、既定のテーマと、この組織での自分、所属するワークスペース、管理者ならお試しの期限と残りの日数を返す。include_storage:true を指定した管理者だけ容量の合計と内訳を取得する。呼ぶと last_seen_at を書く（1時間に1回まで）',
  mode: 'read',
  permission: 'organization',
  // 管理画面の容量の節だけが明示する。組織の枠では本文と全過去版を走査しない。
  input: z.object({ include_storage: z.boolean().optional() }),
  output: z.object({
    organization: z.object({
      name: z.string(),
      // team はチーム用、personal は自分用（1人だけ。招待と管理者の指名はできない）
      kind: z.enum(organizationKinds),
      theme,
      // 組織にワークスペースが1つでもあるか（所属していないものと、閉じたものを含む）。最初のワークスペースを作る案内の判定に使う
      has_workspaces: z.boolean(),
    }),
    // level は自分のレベル（組織の中の経験値の合計から出す）。アカウントのメニューの紋章に使い、経験値の数値は返さない
    me: z.object({
      id: z.string(),
      name: z.string(),
      is_admin: z.boolean(),
      theme: theme.nullable(),
      level: z.number().int(),
    }),
    // 組織全体の内訳は管理者だけ。一般のメンバーには所属していないワークスペースも含めて見せない。
    storage: z
      .object({
        used_bytes: z.number().int(),
        quota_bytes: z.number().int(),
        organization_wiki_bytes: z.number().int(),
        workspaces: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            closed_at: z.string().nullable(),
            used_bytes: z.number().int(),
          }),
        ),
      })
      .nullable(),
    trial: z.object({ ends_on: z.string(), days_left: z.number().int() }).nullable(),
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['leader', 'member']) })),
  }),
});
