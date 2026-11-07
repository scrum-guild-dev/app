import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { conflictReasonOf } from '../conflict-reason.ts';
import { defineOperation } from '../define.ts';

// 受信箱に1回の読み取りで返すタスクの上限と、バックログへ1回で入れるタスクの上限
export const INBOX_LIST_LIMIT = 200;
export const INBOX_MOVE_LIMIT = 100;

// 受信箱の1行。取り込み元のキー、URL、リポジトリ、担当、届いた日時を画面が行に出す。本文は載せない
export const inboxTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  // 取り込み元のキー（owner/repo#12）と URL、取り込み元のリポジトリの名前、取り込んだ接続の名前
  source_key: z.string(),
  source_url: z.string(),
  source_container_name: z.string(),
  connection_name: z.string(),
  // このワークスペースで振ったリポジトリ。未定は null（バックログへ入れる前に選べる）
  repository: z.object({ id: z.string(), name: z.string() }).nullable(),
  // 担当。いなければ null。名前は、離脱済みの人でも出す
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  // 受信箱に届いた日時（UTC）。画面はブラウザのタイムゾーンで出す
  arrived_at: z.string(),
});
export type InboxTask = z.output<typeof inboxTaskSchema>;

// 受信箱の一覧。削除していない、受信箱（tray = 'inbox'）のタスクを、届いた日時の新しい順（同じなら id の降順）に
// INBOX_LIST_LIMIT 件まで返す。total は受信箱の全件の数（上限を超えたとき、画面が残りを知らせる）。
// connection_count は削除していない接続の数（0 のとき画面は接続の登録へ誘う）、last_success_at はその最後に成功した日時（無ければ null）。
// repositories は、バックログへ入れる前に選べるリポジトリ（削除していないもの）。閉じたワークスペースでも読める
export const inboxList = defineOperation({
  name: 'inbox-list',
  description: '受信箱のタスクと、接続の最後に成功した日時を読む',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({
    tasks: z.array(inboxTaskSchema),
    total: z.number().int(),
    connection_count: z.number().int(),
    last_success_at: z.string().nullable(),
    repositories: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});

// バックログへ入れるのを 409 の conflict で断った理由（details.reason）。
// not_in_inbox は、選んだタスクに受信箱に無いもの（すでにバックログへ入れた、アーカイブした）が混じった。何も移さず、読み直しを促す
export const inboxMoveConflictReasons = ['not_in_inbox'] as const;
export type InboxMoveConflictReason = (typeof inboxMoveConflictReasons)[number];

export function inboxMoveConflictReasonOf(details: unknown): InboxMoveConflictReason | undefined {
  return conflictReasonOf(details, inboxMoveConflictReasons);
}

// 選んだ受信箱のタスク（INBOX_MOVE_LIMIT 件まで）を、まとめてバックログの親のない末尾へ移す。
// 移す順は届いた日時の古い順（同じなら id の昇順）で、末尾に元の並びのまま振る。変更の履歴は {"tray": ["inbox", "backlog"]}。
// repository_id を渡した行は、移す前にそのリポジトリを振る（履歴は {"repository": [前, 後]}。今と同じなら書かない。null は渡せない）。
// 無いタスク（別の組織・別のワークスペース・削除済み）や振れないリポジトリは 404。
// 受信箱に無いタスクが混じったときは何も移さず 409 の conflict（reason は not_in_inbox）。同じ ID の重複は 400。
// 閉じたワークスペースは 409 の workspace_closed。書く文はどれも「選んだ全件が受信箱にある」「ワークスペースが開いている」を条件にし、
// 読んでから書くまでに誰かが動かしたときは、何も書かず 409 の conflict（reason なし）
export const inboxToBacklog = defineOperation({
  name: 'inbox-to-backlog',
  description: '選んだ受信箱のタスクを、バックログの末尾へまとめて移す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    items: z
      .array(z.object({ task_id: idSchema, repository_id: idSchema.optional() }))
      .min(1)
      .max(INBOX_MOVE_LIMIT)
      .refine((items) => new Set(items.map((item) => item.task_id)).size === items.length, {
        message: '同じタスクを2回選べません',
      }),
  }),
  output: z.object({ moved: z.number().int() }),
});
