-- Migration number: 0018 	 2026-11-02T14:02:26.330Z
-- 添付ファイルの情報（#743）。列と制約、索引は docs/data-model.md の attachments の写し。組織の中の表。
-- 広げる変更（表を足す）で、前の版のコードはこの表を読み書きしない。この版では添付の行を作る操作はまだ無い。
-- 付く先と uploaded_by の外部キーは親の物理削除を止める。組織を消す SQL は、この表を親より先に消す。
-- 付く先のない行は attached_at も空にし、created_at の部分索引で期限切れの掃除に備える。

CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  task_id TEXT REFERENCES tasks (id),
  story_id TEXT REFERENCES stories (id),
  epic_id TEXT REFERENCES epics (id),
  comment_id TEXT REFERENCES comments (id),
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  uploaded_by TEXT NOT NULL REFERENCES users (id),
  attached_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((task_id IS NOT NULL) + (story_id IS NOT NULL) + (epic_id IS NOT NULL) + (comment_id IS NOT NULL) <= 1),
  CHECK ((attached_at IS NULL) = (task_id IS NULL AND story_id IS NULL AND epic_id IS NULL AND comment_id IS NULL))
);

CREATE INDEX attachments_task_id ON attachments (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX attachments_story_id ON attachments (story_id) WHERE story_id IS NOT NULL;
CREATE INDEX attachments_epic_id ON attachments (epic_id) WHERE epic_id IS NOT NULL;
CREATE INDEX attachments_comment_id ON attachments (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX attachments_workspace_id ON attachments (workspace_id);
CREATE INDEX attachments_created_at_unattached ON attachments (created_at) WHERE attached_at IS NULL;
CREATE INDEX attachments_uploaded_by ON attachments (uploaded_by);
