-- 縮める変更。代替索引を追加した #296（PR #561）を含む v0.3.0 の本番反映後に適用する。
-- 経験値の合計用の索引が同じ先頭の列を持つため、冗長な索引を削除する（#560）。
-- user_id の外部キーの検査は xp_grants_user_workspace_amount が引き続き受け持つ。
DROP INDEX xp_grants_user_workspace;
