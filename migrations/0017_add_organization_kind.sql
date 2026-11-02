-- Migration number: 0017	2026-11-02T00:00:00.000Z
-- 組織の種類（チーム用か自分用か）と、自分用の組織を1アカウントに1つにする部分 UNIQUE 索引。
-- 既存の行は kind が既定の team になる。自分用の行はこの版が初めて書くので、索引は今ある行に当たらない。

ALTER TABLE organizations ADD COLUMN kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'personal'));

CREATE UNIQUE INDEX organizations_personal_owner
  ON organizations (created_by_account_id)
  WHERE kind = 'personal';
