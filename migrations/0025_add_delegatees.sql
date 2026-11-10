-- 自分用の組織の依頼先の名簿。論理削除後も完了したタスクから名前を引く。
CREATE TABLE delegatees (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  deleted_at TEXT CHECK (deleted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) IS deleted_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
);
-- 組織の物理削除と一覧を、それぞれ全行と未削除の行で引く。
CREATE INDEX delegatees_organization ON delegatees (organization_id);
CREATE INDEX delegatees_organization_name ON delegatees (organization_id, name) WHERE deleted_at IS NULL;

ALTER TABLE tasks ADD COLUMN delegatee_id TEXT REFERENCES delegatees (id);
CREATE INDEX tasks_delegatee_completed ON tasks (delegatee_id, completed_at) WHERE delegatee_id IS NOT NULL;
