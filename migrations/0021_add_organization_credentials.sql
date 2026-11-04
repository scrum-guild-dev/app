-- 組織の管理者が止めた認証は、その組織でだけ拒む。
-- max() の文字列比較と時刻順を揃えるため、線はアプリが書く UTC ミリ秒形式だけを許す。
ALTER TABLE users ADD COLUMN credentials_not_before TEXT
  CHECK (credentials_not_before IS NULL OR
    (length(credentials_not_before) = 24 AND credentials_not_before GLOB '????-??-??T??:??:??.???Z'));
-- 既に無効な旧アプリ行にも線を残す。形式が異なる旧データの日時は推定しない。
UPDATE users SET credentials_not_before = disabled_at
  WHERE length(disabled_at) = 24 AND disabled_at GLOB '????-??-??T??:??:??.???Z';

-- 古い版が書く NULL は、読む側で created_at として扱う。
ALTER TABLE api_tokens ADD COLUMN authenticated_at TEXT
  CHECK (authenticated_at IS NULL OR authenticated_at GLOB '????-??-??T??:??:??*Z');
-- 旧列には形式の CHECK がない。非一致は NULL のまま読み取り側に任せる。
UPDATE api_tokens SET authenticated_at = created_at
  WHERE created_at GLOB '????-??-??T??:??:??*Z';
