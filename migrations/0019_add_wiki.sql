-- Wiki のページと保存した版。組織とワークスペースで共有する。
CREATE TABLE wiki_pages (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  workspace_id TEXT REFERENCES workspaces(id),
  parent_id TEXT REFERENCES wiki_pages(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  version INTEGER NOT NULL CHECK (version >= 1),
  position TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  deleted_at TEXT CHECK (deleted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) IS deleted_at),
  deleted_by TEXT REFERENCES users(id),
  body_md TEXT NOT NULL CHECK (length(body_md) <= 100000),
  CHECK ((organization_id IS NULL) <> (workspace_id IS NULL)),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX wiki_pages_organization_tree ON wiki_pages(organization_id, parent_id, position) WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX wiki_pages_workspace_tree ON wiki_pages(workspace_id, parent_id, position) WHERE workspace_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX wiki_pages_parent ON wiki_pages(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX wiki_pages_organization ON wiki_pages(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX wiki_pages_workspace ON wiki_pages(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX wiki_pages_creator ON wiki_pages(created_by);
CREATE INDEX wiki_pages_updater ON wiki_pages(updated_by);
CREATE INDEX wiki_pages_deleter ON wiki_pages(deleted_by) WHERE deleted_by IS NOT NULL;
CREATE INDEX wiki_pages_deleted ON wiki_pages(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TABLE wiki_page_revisions (
  page_id TEXT NOT NULL REFERENCES wiki_pages(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  body_md TEXT NOT NULL CHECK (length(body_md) <= 100000),
  saved_by TEXT NOT NULL REFERENCES users(id),
  saved_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', saved_at) IS saved_at),
  PRIMARY KEY (page_id, version)
);
CREATE INDEX wiki_page_revisions_saver ON wiki_page_revisions(saved_by);
