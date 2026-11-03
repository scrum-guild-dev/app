-- Migration number: 0020 	 2026-11-03T15:43:02.795Z
-- 広げる変更。旧版が作る行では NULL のままなので、アプリは created_at として読む。
ALTER TABLE sessions ADD COLUMN api_token_seen_at TEXT
  CHECK (api_token_seen_at IS NULL OR (
    typeof(api_token_seen_at) = 'text'
    AND length(api_token_seen_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', api_token_seen_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', api_token_seen_at) = api_token_seen_at
  ));

-- 旧版が許した時差・秒精度の表記も UTC へそろえる。読めない既存値は NULL のままにする。
-- now・Julian day は ISO 日時ではない。変換後が4桁の年を越える値も埋めない。
UPDATE sessions SET api_token_seen_at = CASE
  WHEN created_at GLOB '[0-9][0-9][0-9][0-9]-??-??T*'
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', created_at)) = 24
  THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
END;
