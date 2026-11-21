import { sql, type RawBuilder } from 'kysely';

// column（表の別名つきの列）を、SQLite が索引を選ぶときに使わない形にする（単項の + を付ける。SQLite の決まった書き方）。
// 結ぶ順を CROSS JOIN で固定した文で、絞り込みの条件の列に別の索引があると、SQLite がその索引で結ぶ側を引き直す計画を選ぶことがある。
// 例: 完了した親のないタスクの読み取りで story_id の IS NULL に tasks_story を使わせないため。ANALYZE の後は、
// SQLite が NULL を別々の値と数えて tasks_story を選び、全組織の親のないタスクを読む計画になる
// 例: 親のないタスクを依頼先で絞るとき、ワークスペースの索引の代わりに tasks_delegatee_completed を選ばせない（#907）
// 列は、使う列の名前（別名つき）だけを受ける（任意の文字列を SQL の参照にしない）
export type UnindexedColumn = 'tasks.delegatee_id' | 'tasks.story_id' | 'tasks.workspace_id' | 't.workspace_id';

export function unindexed(column: UnindexedColumn): RawBuilder<unknown> {
  return sql`+${sql.ref(column)}`;
}
