-- 経験値の合計用の索引が同じ先頭の列を持つため、冗長な索引を削除する（#560）。
-- user_id の外部キーの検査は xp_grants_user_workspace_amount が引き続き受け持つ。
DROP INDEX xp_grants_user_workspace;
