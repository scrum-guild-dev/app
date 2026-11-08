# 画面の読み込みの計測結果（#1042）

2026-11-09（日本時間）、基準コミット `06e69b6`、Node 26.13.0 / pnpm 12.12.0 / Wrangler 4.153.0。`pnpm bench:loading` を同じコードで2回実行した。各 load は温め2回、計測20回。全体テスト・build・lint が終わってから順に実行し、検査と重ねていない。共通枠を含む各 load の API 待ちを別々に測った値で、ブラウザの表示時間ではない。方法とデータ量は [開発手順](development.md#画面の読み込みを測る) を参照。

両回とも全 API が成功し、出力スキーマの検査も通った。別々の一時 D1 は終了後に削除され、計測ポート9742は閉じた。開始前後の既存 `.wrangler/state` 19ファイルの SHA-256 とファイル一覧はすべて一致した（作業ワークツリーには既存 D1 なし）。本番は使っていない。

## 後回しの候補

値は試行ごとの「従の最終完了 − 主の最終完了」の正の部分の分位点（ms）。両回とも p50 が正の load は次の5つ。共通の枠の招待は招待ありの分岐を強制し、seed の一覧を読む。通常の招待なしの枠では短縮候補にならなかった。

| load | 1回目 p50 / p95 | 2回目 p50 / p95 | 判定 |
| --- | ---: | ---: | --- |
| `/[slug]/+layout（招待あり）` | 11.73 / 15.07 | 14.06 / 17.41 | 両回で候補 |
| `/[slug]` | 17.05 / 23.58 | 19.95 / 35.80 | 両回で候補 |
| `/[slug]/w/[id]` | 12.90 / 16.58 | 16.03 / 21.09 | 両回で候補 |
| `/[slug]/w/[id]/plan` | 12.10 / 15.30 | 13.13 / 18.64 | 両回で候補 |
| `/[slug]/w/[id]/epics/[epicId]` | 9.29 / 10.17 | 9.05 / 10.46 | 両回で候補 |

そのほかの load は短縮見込みの p50 が0だった。10〜20ms程度の差を含むローカルでの候補であり、本番の体感差や実装後の改善量は未確認。逐次で待つ招待の追加分と、並列の従が主より遅いケースを分けて考える。後回しの方式と優先順位は後続 Issue で決め、実装後に同じ条件で再測定する。

並行する #1018 は今日の `experience-summary` を外すため、マージ後には今日の操作表を更新して再測定する。この表の数字を更新後の今日の判断にそのまま使わない。#1052 の health 変更を見込み、計測設定には公開の固定の暗号鍵を渡しているが、マージ後の組み合わせは未検証。

後続5件を親 #827 の下に登録した: [#1054](https://github.com/scrum-guild-dev/app/issues/1054)、[#1055](https://github.com/scrum-guild-dev/app/issues/1055)、[#1056](https://github.com/scrum-guild-dev/app/issues/1056)、[#1057](https://github.com/scrum-guild-dev/app/issues/1057)、[#1058](https://github.com/scrum-guild-dev/app/issues/1058)。[登録内容の控え](loading-bench-followups.md) に対象と受け入れ条件を残した。

## 1回目の全結果

| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| / | my-organizations（主） | 17.22 | 20.02 |
| / | 合計（各試行の最長） | 17.22 | 20.02 |
| / | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /auth/setup | onboarding-status（主） | 12.35 | 18.00 |
| /auth/setup | me（主） | 18.21 | 25.65 |
| /auth/setup | 合計（各試行の最長） | 18.21 | 25.65 |
| /auth/setup | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /operator | list-organizations（主） | 14.56 | 16.61 |
| /operator | 合計（各試行の最長） | 14.56 | 16.61 |
| /operator | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/+layout | organization（主） | 13.82 | 17.80 |
| /[slug]/+layout | my-organizations（主） | 33.16 | 37.12 |
| /[slug]/+layout | token-notice（従） | 33.04 | 37.22 |
| /[slug]/+layout | 合計（各試行の最長） | 33.16 | 37.22 |
| /[slug]/+layout | 後回しの短縮見込み: なし | 0.00 | 0.09 |
| /[slug]/+layout（招待あり） | organization（主） | 12.47 | 14.86 |
| /[slug]/+layout（招待あり） | my-organizations（主） | 29.61 | 37.57 |
| /[slug]/+layout（招待あり） | token-notice（従） | 29.41 | 37.86 |
| /[slug]/+layout（招待あり） | invitation-list（従） | 11.73 | 15.07 |
| /[slug]/+layout（招待あり） | 合計（各試行の最長） | 41.15 | 50.51 |
| /[slug]/+layout（招待あり） | 後回しの短縮見込み: 候補 | 11.73 | 15.07 |
| /[slug] | today（主） | 13.12 | 33.69 |
| /[slug] | experience-summary（従） | 31.60 | 35.30 |
| /[slug] | first-steps（従） | 31.70 | 35.46 |
| /[slug] | 合計（各試行の最長） | 31.88 | 35.46 |
| /[slug] | 後回しの短縮見込み: 候補 | 17.05 | 23.58 |
| /[slug]/admin | 操作なし | — | — |
| /[slug]/invitations | invitation-list（主） | 11.33 | 12.84 |
| /[slug]/invitations | 合計（各試行の最長） | 11.33 | 12.84 |
| /[slug]/invitations | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/me | experience-summary（主） | 13.22 | 36.76 |
| /[slug]/me | experience-grants（主） | 39.76 | 49.54 |
| /[slug]/me | token-list（主） | 40.33 | 49.17 |
| /[slug]/me | invitation-list（主） | 40.35 | 49.81 |
| /[slug]/me | me（主） | 40.29 | 49.67 |
| /[slug]/me | 合計（各試行の最長） | 40.70 | 49.81 |
| /[slug]/me | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/+layout | workspace（主） | 10.84 | 13.80 |
| /[slug]/w/[id]/+layout | 合計（各試行の最長） | 10.84 | 13.80 |
| /[slug]/w/[id]/+layout | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id] | backlog-tree（主） | 38.90 | 52.83 |
| /[slug]/w/[id] | category-repository-list（従） | 50.76 | 58.25 |
| /[slug]/w/[id] | experience-team-total（従） | 50.60 | 58.51 |
| /[slug]/w/[id] | 合計（各試行の最長） | 51.55 | 58.51 |
| /[slug]/w/[id] | 後回しの短縮見込み: 候補 | 12.90 | 16.58 |
| /[slug]/w/[id]/plan | sprint-list（主） | 17.94 | 29.28 |
| /[slug]/w/[id]/plan | plan-summary（従） | 27.48 | 30.82 |
| /[slug]/w/[id]/plan | 合計（各試行の最長） | 27.48 | 30.82 |
| /[slug]/w/[id]/plan | 後回しの短縮見込み: 候補 | 12.10 | 15.30 |
| /[slug]/w/[id]/sprint | sprint-board（主） | 13.53 | 15.90 |
| /[slug]/w/[id]/sprint | 合計（各試行の最長） | 13.53 | 15.90 |
| /[slug]/w/[id]/sprint | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/settings | category-repository-list（主） | 11.14 | 12.95 |
| /[slug]/w/[id]/settings | column-list（主） | 28.68 | 31.55 |
| /[slug]/w/[id]/settings | detail-field-list（主） | 28.74 | 31.06 |
| /[slug]/w/[id]/settings | 合計（各試行の最長） | 28.74 | 31.55 |
| /[slug]/w/[id]/settings | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/members | member-list（主） | 17.04 | 23.20 |
| /[slug]/w/[id]/members | 合計（各試行の最長） | 17.04 | 23.20 |
| /[slug]/w/[id]/members | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/inbox | inbox-list（主） | 14.89 | 29.11 |
| /[slug]/w/[id]/inbox | 合計（各試行の最長） | 14.89 | 29.11 |
| /[slug]/w/[id]/inbox | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/connections | connection-list（主） | 11.24 | 12.28 |
| /[slug]/w/[id]/connections | 合計（各試行の最長） | 11.24 | 12.28 |
| /[slug]/w/[id]/connections | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/epics/[epicId] | epic-detail（主） | 13.16 | 17.64 |
| /[slug]/w/[id]/epics/[epicId] | category-repository-list（従） | 22.44 | 25.78 |
| /[slug]/w/[id]/epics/[epicId] | 合計（各試行の最長） | 22.44 | 25.78 |
| /[slug]/w/[id]/epics/[epicId] | 後回しの短縮見込み: 候補 | 9.29 | 10.17 |
| /[slug]/wiki | org-wiki-tree（主） | 11.32 | 19.28 |
| /[slug]/wiki | 合計（各試行の最長） | 11.32 | 19.28 |
| /[slug]/wiki | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/wiki/[pageId] | org-wiki-tree（主） | 11.88 | 16.11 |
| /[slug]/wiki/[pageId] | org-wiki-page（主） | 20.69 | 25.51 |
| /[slug]/wiki/[pageId] | 合計（各試行の最長） | 20.69 | 25.51 |
| /[slug]/wiki/[pageId] | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki | workspace-wiki-tree（主） | 12.68 | 21.43 |
| /[slug]/w/[id]/wiki | 合計（各試行の最長） | 12.68 | 21.43 |
| /[slug]/w/[id]/wiki | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki/[pageId] | workspace-wiki-tree（主） | 12.65 | 20.45 |
| /[slug]/w/[id]/wiki/[pageId] | workspace-wiki-page（主） | 22.08 | 27.49 |
| /[slug]/w/[id]/wiki/[pageId] | 合計（各試行の最長） | 22.08 | 27.49 |
| /[slug]/w/[id]/wiki/[pageId] | 後回しの短縮見込み: なし | 0.00 | 0.00 |

## 2回目の全結果

| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| / | my-organizations（主） | 17.15 | 22.02 |
| / | 合計（各試行の最長） | 17.15 | 22.02 |
| / | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /auth/setup | onboarding-status（主） | 10.70 | 15.70 |
| /auth/setup | me（主） | 16.17 | 21.40 |
| /auth/setup | 合計（各試行の最長） | 16.17 | 21.40 |
| /auth/setup | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /operator | list-organizations（主） | 14.75 | 16.50 |
| /operator | 合計（各試行の最長） | 14.75 | 16.50 |
| /operator | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/+layout | organization（主） | 14.08 | 23.36 |
| /[slug]/+layout | my-organizations（主） | 32.78 | 40.59 |
| /[slug]/+layout | token-notice（従） | 32.51 | 40.33 |
| /[slug]/+layout | 合計（各試行の最長） | 32.78 | 40.59 |
| /[slug]/+layout | 後回しの短縮見込み: なし | 0.00 | 0.02 |
| /[slug]/+layout（招待あり） | organization（主） | 15.08 | 30.35 |
| /[slug]/+layout（招待あり） | my-organizations（主） | 33.64 | 56.11 |
| /[slug]/+layout（招待あり） | token-notice（従） | 33.93 | 55.83 |
| /[slug]/+layout（招待あり） | invitation-list（従） | 14.03 | 16.80 |
| /[slug]/+layout（招待あり） | 合計（各試行の最長） | 50.07 | 73.53 |
| /[slug]/+layout（招待あり） | 後回しの短縮見込み: 候補 | 14.06 | 17.41 |
| /[slug] | today（主） | 17.94 | 21.68 |
| /[slug] | experience-summary（従） | 37.92 | 54.81 |
| /[slug] | first-steps（従） | 37.58 | 54.84 |
| /[slug] | 合計（各試行の最長） | 37.92 | 54.84 |
| /[slug] | 後回しの短縮見込み: 候補 | 19.95 | 35.80 |
| /[slug]/admin | 操作なし | — | — |
| /[slug]/invitations | invitation-list（主） | 12.72 | 14.19 |
| /[slug]/invitations | 合計（各試行の最長） | 12.72 | 14.19 |
| /[slug]/invitations | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/me | experience-summary（主） | 13.32 | 16.11 |
| /[slug]/me | experience-grants（主） | 42.55 | 49.09 |
| /[slug]/me | token-list（主） | 42.37 | 49.13 |
| /[slug]/me | invitation-list（主） | 42.37 | 49.03 |
| /[slug]/me | me（主） | 42.14 | 49.07 |
| /[slug]/me | 合計（各試行の最長） | 42.55 | 49.13 |
| /[slug]/me | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/+layout | workspace（主） | 11.36 | 15.80 |
| /[slug]/w/[id]/+layout | 合計（各試行の最長） | 11.36 | 15.80 |
| /[slug]/w/[id]/+layout | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id] | backlog-tree（主） | 39.11 | 55.62 |
| /[slug]/w/[id] | category-repository-list（従） | 57.66 | 63.98 |
| /[slug]/w/[id] | experience-team-total（従） | 57.37 | 63.99 |
| /[slug]/w/[id] | 合計（各試行の最長） | 57.77 | 63.99 |
| /[slug]/w/[id] | 後回しの短縮見込み: 候補 | 16.03 | 21.09 |
| /[slug]/w/[id]/plan | sprint-list（主） | 15.24 | 21.25 |
| /[slug]/w/[id]/plan | plan-summary（従） | 30.23 | 34.38 |
| /[slug]/w/[id]/plan | 合計（各試行の最長） | 30.23 | 34.38 |
| /[slug]/w/[id]/plan | 後回しの短縮見込み: 候補 | 13.13 | 18.64 |
| /[slug]/w/[id]/sprint | sprint-board（主） | 14.36 | 15.99 |
| /[slug]/w/[id]/sprint | 合計（各試行の最長） | 14.36 | 15.99 |
| /[slug]/w/[id]/sprint | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/settings | category-repository-list（主） | 13.21 | 23.30 |
| /[slug]/w/[id]/settings | column-list（主） | 33.27 | 49.65 |
| /[slug]/w/[id]/settings | detail-field-list（主） | 33.27 | 49.53 |
| /[slug]/w/[id]/settings | 合計（各試行の最長） | 33.27 | 49.65 |
| /[slug]/w/[id]/settings | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/members | member-list（主） | 16.23 | 21.39 |
| /[slug]/w/[id]/members | 合計（各試行の最長） | 16.23 | 21.39 |
| /[slug]/w/[id]/members | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/inbox | inbox-list（主） | 15.30 | 28.02 |
| /[slug]/w/[id]/inbox | 合計（各試行の最長） | 15.30 | 28.02 |
| /[slug]/w/[id]/inbox | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/connections | connection-list（主） | 12.25 | 14.44 |
| /[slug]/w/[id]/connections | 合計（各試行の最長） | 12.25 | 14.44 |
| /[slug]/w/[id]/connections | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/epics/[epicId] | epic-detail（主） | 13.14 | 21.78 |
| /[slug]/w/[id]/epics/[epicId] | category-repository-list（従） | 22.36 | 31.23 |
| /[slug]/w/[id]/epics/[epicId] | 合計（各試行の最長） | 22.36 | 31.23 |
| /[slug]/w/[id]/epics/[epicId] | 後回しの短縮見込み: 候補 | 9.05 | 10.46 |
| /[slug]/wiki | org-wiki-tree（主） | 10.76 | 18.80 |
| /[slug]/wiki | 合計（各試行の最長） | 10.76 | 18.80 |
| /[slug]/wiki | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/wiki/[pageId] | org-wiki-tree（主） | 11.47 | 18.81 |
| /[slug]/wiki/[pageId] | org-wiki-page（主） | 19.31 | 24.53 |
| /[slug]/wiki/[pageId] | 合計（各試行の最長） | 19.31 | 24.53 |
| /[slug]/wiki/[pageId] | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki | workspace-wiki-tree（主） | 12.32 | 16.83 |
| /[slug]/w/[id]/wiki | 合計（各試行の最長） | 12.32 | 16.83 |
| /[slug]/w/[id]/wiki | 後回しの短縮見込み: なし | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki/[pageId] | workspace-wiki-tree（主） | 12.08 | 18.56 |
| /[slug]/w/[id]/wiki/[pageId] | workspace-wiki-page（主） | 21.75 | 30.95 |
| /[slug]/w/[id]/wiki/[pageId] | 合計（各試行の最長） | 21.75 | 30.95 |
| /[slug]/w/[id]/wiki/[pageId] | 後回しの短縮見込み: なし | 0.00 | 0.00 |
