-- 組織の管理者が止めた認証は、その組織でだけ拒む。既存ユーザーには制限を掛けない。
ALTER TABLE users ADD COLUMN credentials_not_before TEXT
  CHECK (credentials_not_before IS NULL OR credentials_not_before GLOB '????-??-??T??:??:??*Z');

-- 古い版が書く NULL は、読む側で created_at として扱う。
ALTER TABLE api_tokens ADD COLUMN authenticated_at TEXT
  CHECK (authenticated_at IS NULL OR authenticated_at GLOB '????-??-??T??:??:??*Z');
UPDATE api_tokens SET authenticated_at = created_at;
