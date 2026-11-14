-- 縮める変更。書き込みを止めた #1222 を含む v0.4.1 の本番反映後に適用する。
-- 列単独の CHECK ごと削除し、ほかの列・外部キー・索引は保持する。
ALTER TABLE organizations DROP COLUMN vocabulary;
ALTER TABLE workspaces DROP COLUMN vocabulary;
