-- 本人だけのお気に入り。対象の削除や所属の変更では行を消さない。
CREATE TABLE favorites (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id),
  task_id TEXT REFERENCES tasks(id),
  story_id TEXT REFERENCES stories(id),
  epic_id TEXT REFERENCES epics(id),
  wiki_page_id TEXT REFERENCES wiki_pages(id),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK ((task_id IS NOT NULL) + (story_id IS NOT NULL) + (epic_id IS NOT NULL) + (wiki_page_id IS NOT NULL) = 1),
  CHECK (workspace_id IS NOT NULL OR wiki_page_id IS NOT NULL)
);
CREATE INDEX favorites_user_created ON favorites(user_id, created_at);
CREATE UNIQUE INDEX favorites_user_task ON favorites(user_id, task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX favorites_user_story ON favorites(user_id, story_id) WHERE story_id IS NOT NULL;
CREATE UNIQUE INDEX favorites_user_epic ON favorites(user_id, epic_id) WHERE epic_id IS NOT NULL;
CREATE UNIQUE INDEX favorites_user_wiki_page ON favorites(user_id, wiki_page_id) WHERE wiki_page_id IS NOT NULL;
CREATE INDEX favorites_workspace ON favorites(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX favorites_task ON favorites(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX favorites_story ON favorites(story_id) WHERE story_id IS NOT NULL;
CREATE INDEX favorites_epic ON favorites(epic_id) WHERE epic_id IS NOT NULL;
CREATE INDEX favorites_wiki_page ON favorites(wiki_page_id) WHERE wiki_page_id IS NOT NULL;
