-- Migration number: 0022 	 2026-11-07T00:00:00.000Z
-- 取り込み元の接続と、取り込んだタスクの取り込み元への参照（#918）。列と制約は docs/data-model.md の「接続」と task_sources、
-- task_source_payloads の写し。組織の中の表。広げる変更（表を足す）で、前の版のコードはこれらの表を読み書きしない。
-- provider と scope_kind には CHECK を書かない。値は取り込み元の型の一覧でアプリが検証する（取り込み元を足すときに DB の制約を変えないため）。
-- 外部キーの検査に使う列には索引を足す（主キーの先頭に無い列と、部分索引では使えない列）。

CREATE TABLE connections (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'error', 'stopped')),
  stopped_reason TEXT CHECK (
    stopped_reason IS NULL
    OR stopped_reason IN ('auth_failed', 'owner', 'leader', 'member_left', 'workspace_closed', 'user_disabled')
  ),
  scope_mode TEXT NOT NULL DEFAULT 'include' CHECK (scope_mode IN ('include', 'exclude')),
  ignore_source_due INTEGER NOT NULL DEFAULT 0 CHECK (ignore_source_due IN (0, 1)),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  credential_ciphertext TEXT,
  credential_key_version INTEGER,
  credential_last4 TEXT,
  sync_state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sync_state_json)),
  reconcile_state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(reconcile_state_json)),
  last_success_at TEXT,
  last_reconciled_at TEXT,
  last_error_message TEXT,
  last_error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_manual_sync_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'stopped') = (stopped_reason IS NOT NULL)),
  -- 認証情報の3列は組で入り、削除したら全部消える（鍵の入れ替えは credential_key_version で選ぶ）
  CHECK (
    (credential_ciphertext IS NULL) = (credential_key_version IS NULL)
    AND (credential_ciphertext IS NULL) = (credential_last4 IS NULL)
  ),
  CHECK (deleted_at IS NULL OR credential_ciphertext IS NULL)
);

CREATE INDEX connections_workspace ON connections (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX connections_owner_user_id ON connections (owner_user_id);

CREATE TABLE connection_scopes (
  connection_id TEXT NOT NULL REFERENCES connections (id),
  scope_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  PRIMARY KEY (connection_id, scope_kind, source_id)
);

CREATE TABLE connection_status_mappings (
  connection_id TEXT NOT NULL REFERENCES connections (id),
  source_status TEXT NOT NULL,
  column_id TEXT NOT NULL REFERENCES board_columns (id),
  PRIMARY KEY (connection_id, source_status)
);

-- 列の削除が対応を外す文と、外部キーの検査が引く。
CREATE INDEX connection_status_mappings_column_id ON connection_status_mappings (column_id);

CREATE TABLE task_sources (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  connection_id TEXT NOT NULL REFERENCES connections (id),
  provider TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('issue', 'pull_request', 'review_request')),
  source_id TEXT NOT NULL,
  reviewer_source_id TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_container_id TEXT NOT NULL,
  source_container_name TEXT NOT NULL,
  source_status TEXT NOT NULL,
  source_due_on TEXT CHECK (source_due_on IS date(source_due_on)),
  source_updated_at TEXT NOT NULL,
  is_source_done INTEGER NOT NULL DEFAULT 0 CHECK (is_source_done IN (0, 1)),
  missing_since_at TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- レビュアーの ID はレビュー依頼のときだけ入る（一意のキーで依頼をレビュアーごとに分けるため）
  CHECK ((source_kind = 'review_request') = (reviewer_source_id <> ''))
);

CREATE UNIQUE INDEX task_sources_identity
  ON task_sources (workspace_id, provider, source_kind, source_id, reviewer_source_id);
CREATE INDEX task_sources_connection_id ON task_sources (connection_id);
CREATE INDEX task_sources_container ON task_sources (workspace_id, source_container_id);

CREATE TABLE task_source_payloads (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks (id),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  is_truncated INTEGER NOT NULL DEFAULT 0 CHECK (is_truncated IN (0, 1)),
  updated_at TEXT NOT NULL
);
