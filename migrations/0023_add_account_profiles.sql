-- アカウントごとの表示する名前と肩書き。OAuth のログイン情報とは分離する（#1021）。
-- 新しい表の追加だけなので、以前の版はこの表を使わず動く。
-- 物理削除する場合は、ほかの表と同じくアプリが子から順に消す。
CREATE TABLE account_profiles (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND instr(name, char(0)) = 0),
  title TEXT NOT NULL CHECK (length(title) <= 100 AND instr(title, char(0)) = 0),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z')
);
