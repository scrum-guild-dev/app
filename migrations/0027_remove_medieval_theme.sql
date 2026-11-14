-- 中世風のテーマを消した。選んでいた人は、選んでいない（シンプル（自動））に戻す。
-- 列の CHECK は medieval を許したまま残す（CHECK を変えるには表を作り直すため）。アプリは medieval を書かない。
-- 組織の既定のテーマ（organizations.theme）は使わなくなった。列は、使わない版を出した後の別の変更で消す。
-- 組織の既定に従っていた人（users.theme が NULL）は、組織の既定を写さず、シンプル（自動）になる。テーマは各自が選ぶだけにしたため
-- （写すには共通の表と組織の中の表を1つの SQL で結ぶことになり、docs/data-model.md の「データベースの分け方」に反する）。
UPDATE users SET theme = NULL WHERE theme = 'medieval';
