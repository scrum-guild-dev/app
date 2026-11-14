-- 中世風のテーマを消した。選んでいた人は、選んでいない（シンプル（自動））に戻す。
-- 列の CHECK は medieval を許したまま残す（CHECK を変えるには表を作り直すため）。アプリは medieval を書かない。
-- 組織の既定のテーマ（organizations.theme）は使わなくなった。列は、使わない版を出した後の別の変更で消す。
UPDATE users SET theme = NULL WHERE theme = 'medieval';
