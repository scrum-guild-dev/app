-- 縮める変更。組織の既定のテーマを使わなくした #1195 を含む v0.3.0 の本番反映後に適用する。
-- users.theme の CHECK と organizations.vocabulary は変えない。
ALTER TABLE organizations DROP COLUMN theme;
