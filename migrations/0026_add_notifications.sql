-- 通知の保存と、共通 DB で確保した容量警告の再試行。
ALTER TABLE organizations ADD COLUMN attachment_quota_warning_pending_at TEXT
  CHECK (attachment_quota_warning_pending_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', attachment_quota_warning_pending_at) IS attachment_quota_warning_pending_at);
ALTER TABLE organizations ADD COLUMN attachment_quota_check_pending_at TEXT
  CHECK (attachment_quota_check_pending_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', attachment_quota_check_pending_at) IS attachment_quota_check_pending_at);
-- 日時が NULL に戻った後も世代を保持し、同じ日時の印の再利用を古い集計と区別する。
ALTER TABLE organizations ADD COLUMN attachment_quota_check_generation INTEGER NOT NULL DEFAULT 0
  CHECK (attachment_quota_check_generation BETWEEN 0 AND 9007199254740991);

-- 初期導入では論理参照にする。旧版の組織削除を、新しい子の外部キーで止めないため。
CREATE TABLE notifications (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('source_done', 'source_reopened', 'source_missing', 'connection_failed', 'credential_expiring', 'comment', 'assigned', 'party_assigned', 'reward_changed', 'thanked', 'attachment_quota_warning')),
  task_id TEXT,
  epic_id TEXT,
  connection_id TEXT,
  actor_user_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  read_at TEXT CHECK (read_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', read_at) IS read_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
);
CREATE INDEX notifications_user_created ON notifications(user_id, created_at);
CREATE INDEX notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_actor ON notifications(actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX notifications_read ON notifications(read_at) WHERE read_at IS NOT NULL;
