-- 親行の削除で、外部キーの検査が子の表を全件走査する箇所に索引を足す（#406）。
-- 論理削除された行も検査する。空にできる列は、親を指す行だけを索引に入れる。

CREATE INDEX users_account_fk ON users (account_id) WHERE account_id IS NOT NULL;

-- 一覧にも選ばれる索引には、所属期間や論理削除の絞り込みに使う列も含める。
CREATE INDEX memberships_workspace_fk ON memberships (workspace_id, left_at, user_id);
CREATE INDEX invitations_workspace_fk ON invitations (workspace_id);
CREATE INDEX board_columns_workspace_fk ON board_columns (workspace_id, deleted_at, position);
CREATE INDEX detail_fields_workspace_fk ON detail_fields (workspace_id, deleted_at, position);
CREATE INDEX categories_workspace_fk ON categories (workspace_id, deleted_at, position);
CREATE INDEX repositories_workspace_fk ON repositories (workspace_id, deleted_at, position);
CREATE INDEX connections_workspace_fk ON connections (workspace_id, deleted_at);
CREATE INDEX epics_workspace_fk ON epics (workspace_id, deleted_at, position);
CREATE INDEX stories_workspace_fk ON stories (workspace_id, epic_id, deleted_at, position);
CREATE INDEX sprints_workspace_fk ON sprints (workspace_id);
CREATE INDEX tasks_workspace_fk ON tasks (workspace_id);
CREATE INDEX thanks_workspace_fk ON thanks (workspace_id);

-- コメント一覧と件数がこの索引を選んでも、対象タスクに絞り、一覧を索引順で読める。
CREATE INDEX comments_workspace_task_fk ON comments (workspace_id, task_id, created_at, id);

CREATE INDEX epics_category_fk ON epics (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX stories_category_fk ON stories (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX stories_epic_fk ON stories (epic_id) WHERE epic_id IS NOT NULL;
-- バックログの配下も、削除日時と完了日時で絞れるようにする。
CREATE INDEX tasks_story_fk ON tasks (story_id, deleted_at, completed_at, id) WHERE story_id IS NOT NULL;
CREATE INDEX tasks_sprint_fk ON tasks (sprint_id) WHERE sprint_id IS NOT NULL;
CREATE INDEX tasks_column_fk ON tasks (column_id) WHERE column_id IS NOT NULL;
-- 旧版のバックログがこの索引を選んでも、ストーリーごとの未完了行まで絞る。
CREATE INDEX tasks_repository_fk ON tasks (repository_id, story_id, deleted_at, completed_at)
  WHERE repository_id IS NOT NULL;
CREATE INDEX tasks_category_fk ON tasks (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX completions_category_fk ON completions (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX sprint_entries_sprint_fk ON sprint_entries (sprint_id);

-- ストーリーごとにワークスペース全体を読む計画を避けるため、候補の索引の統計をそろえる。
ANALYZE tasks_workspace_fk;
ANALYZE stories_workspace_fk;
