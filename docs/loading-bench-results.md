# 画面の読み込みの計測結果（#1042）

今日の画面（`/[slug]`）の行は #1065 で再測定した値に更新している。基準コミットと条件は「今日の画面の再測定」を参照。他の画面は以下の元の計測値を残している。

2026-11-09（日本時間）。API は main `63f1a48` を基準とし、本 PR の計測スクリプトで `pnpm bench:loading` を2回実行した。Node 26.13.0 / pnpm 12.12.0 / Wrangler 4.153.0。各 load・発行順で温め2回と計測20回（正順20回・逆順20回）。出力スキーマの検査は、逐次の群も含む全応答の時間を確定した後にまとめて行う。他の build・テストと重ねていない。

## 結論と判定できないこと

このローカル計測では、**並列の従のデータを後回しにすべきかは判定不能**。Worker/D1 が要求を実質直列に処理する場合、発行順で完了順も替わる。正順と逆順の両方で差が正になるかという条件でも、操作の重さと待ちの構造を切り分けられない。差が0になることから「後回しは不要」「実装を勧めない」とは結論しない。

逐次に読む招待件数は、先行群を待った後にさらに待つため、構造上の候補。ただし、その数値が本番の体感差や後回しの実装後の改善量を保証するわけではない。並列の token-notice の適否はここから判断できない。

初回の「5か所が候補」と、その後の「並列4か所は候補外なので実装を勧めない」という解釈は、どちらも撤回する。下表は、各試行の `max(0, 従の最終完了 − 主の最終完了)` の分位点を診断値として報告するもの。実装の可否を決めるには、主だけと主＋従の比較、または実運用に近い同時実行環境での追加測定が必要。

| load | 1回目 正順 p50/p95 | 1回目 逆順 p50/p95 | 2回目 正順 p50/p95 | 2回目 逆順 p50/p95 | 解釈 |
| --- | ---: | ---: | ---: | ---: | --- |
| `/[slug]/+layout（招待あり）` | 12.76 / 16.94 | 11.60 / 17.26 | 11.93 / 13.60 | 12.59 / 16.17 | 招待件数は逐次のため構造上の候補。並列部分は判定不能 |
| `/[slug]` | 13.97 / 23.19 | 0.00 / 0.00 | 12.72 / 15.82 | 0.00 / 0.00 | 並列の従は判定不能（#1065 で再測定） |
| `/[slug]/w/[id]` | 17.01 / 19.99 | 0.00 / 0.00 | 16.44 / 18.65 | 0.00 / 0.00 | 並列の従は判定不能 |
| `/[slug]/w/[id]/plan` | 14.11 / 18.13 | 0.00 / 0.00 | 14.97 / 22.32 | 0.00 / 0.05 | 並列の従は判定不能 |
| `/[slug]/w/[id]/epics/[epicId]` | 9.03 / 10.52 | 0.00 / 0.00 | 9.17 / 10.13 | 0.00 / 0.00 | 並列の従は判定不能 |

単位は ms。正順をまとめて測ってから逆順を測るので、時間経過・キャッシュと発行順の効果も分離していない。招待ありの行は招待件数を逐次で読む分岐を強制する。招待なしの枠は、その追加待ちがない。管理のページは親の権限確認だけなので操作なし。

追加データはタスク5,000件・エピック10件・ストーリー100件、進行中のスプリントと未完了30件、終了スプリント3件、直近7日の完了履歴約4,000件・経験値約3,200件、コメント5,000件、組織とワークスペースの Wiki 各100ページ。fixture の基準時刻は一度だけ決め、UTCの日付境界をまたいでも全ての文で同じ時刻を使う。実マイグレーションと seed に適用し、履歴の対応・集計・終了日時・外部キーをテストした。接続・受信箱・sprint_entries などは seed の量であり、全操作の実運用条件や最悪条件、加入履歴を網羅しない。

両回とも全 API が成功し、出力スキーマの検査も通った。一時 D1 を削除し、ポート9742が閉じたことを確認。前後の既存 D1 40ファイルの一覧・SHA-256 は一致した。ブラウザの描画や初回の画面全体は測っていない。方法・主従の意味と限界は [開発手順](development.md#画面の読み込みを測る) を参照。

## 後続 Issue

親 #827 の下に登録済みの [#1054](https://github.com/scrum-guild-dev/app/issues/1054)（招待件数）は逐次の構造上の候補。[#1055](https://github.com/scrum-guild-dev/app/issues/1055)（今日）、[#1056](https://github.com/scrum-guild-dev/app/issues/1056)（バックログ）、[#1057](https://github.com/scrum-guild-dev/app/issues/1057)（計画）、[#1058](https://github.com/scrum-guild-dev/app/issues/1058)（エピック）は、この方式では実装可否を判定できない。両方の過大な解釈を撤回した旨を各 Issue に追記し、追加測定を先にする。現在の状態と今後の判断は GitHub を正とし、本文の写しは文書に持たない。

## 今日の画面の再測定（#1065）

2026-11-09（日本時間）。#1018 のマージ後の main `43da430` に計測表の修正を加え、同じ版の Node・pnpm・Wrangler、温め2回・計測20回で `pnpm bench:loading` を2回実行した。他の build・テストや計測と重ねていない。今日の画面（`/[slug]`）は `today` が主、`first-steps` だけが従。上の診断値の表と下の全結果のうち、今日の行だけを今回の値に置き換え、他の画面は元の計測値を残した。並列の従を後回しにする適否は引き続き判定不能。変更前の値との差を改善量としては扱わない。

両回とも全 API と出力スキーマの検査が成功し、使い捨て D1 は削除された。#1052 を含む main との組み合わせで health の版の照合も通った。既存の手元 D1 と本番は使っていない。

## 1回目の全結果

| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| / | 正順: my-organizations（主） | 17.08 | 21.94 |
| / | 正順: 合計（各試行の最終完了） | 17.10 | 21.96 |
| / | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| / | 逆順: my-organizations（主） | 15.42 | 26.21 |
| / | 逆順: 合計（各試行の最終完了） | 15.42 | 26.21 |
| / | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| / | 従なし | — | — |
| /auth/setup | 正順: onboarding-status（主） | 10.91 | 17.97 |
| /auth/setup | 正順: me（主） | 16.42 | 25.87 |
| /auth/setup | 正順: 合計（各試行の最終完了） | 16.71 | 26.17 |
| /auth/setup | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /auth/setup | 逆順: onboarding-status（主） | 16.89 | 25.69 |
| /auth/setup | 逆順: me（主） | 9.68 | 16.33 |
| /auth/setup | 逆順: 合計（各試行の最終完了） | 17.19 | 25.99 |
| /auth/setup | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /auth/setup | 従なし | — | — |
| /operator | 正順: list-organizations（主） | 16.06 | 19.89 |
| /operator | 正順: 合計（各試行の最終完了） | 16.07 | 19.92 |
| /operator | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /operator | 逆順: list-organizations（主） | 16.96 | 23.96 |
| /operator | 逆順: 合計（各試行の最終完了） | 16.96 | 23.97 |
| /operator | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /operator | 従なし | — | — |
| /[slug]/+layout | 正順: organization（主） | 14.16 | 30.55 |
| /[slug]/+layout | 正順: my-organizations（主） | 31.25 | 38.35 |
| /[slug]/+layout | 正順: token-notice（従） | 31.09 | 38.07 |
| /[slug]/+layout | 正順: 合計（各試行の最終完了） | 31.54 | 38.64 |
| /[slug]/+layout | 正順: 従と主の完了差（診断値） | 0.06 | 0.24 |
| /[slug]/+layout | 逆順: organization（主） | 32.91 | 41.49 |
| /[slug]/+layout | 逆順: my-organizations（主） | 32.96 | 41.67 |
| /[slug]/+layout | 逆順: token-notice（従） | 10.57 | 15.47 |
| /[slug]/+layout | 逆順: 合計（各試行の最終完了） | 33.24 | 41.93 |
| /[slug]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/+layout | 並列の従: 判定不能 | — | — |
| /[slug]/+layout（招待あり） | 正順: organization（主） | 13.80 | 18.26 |
| /[slug]/+layout（招待あり） | 正順: my-organizations（主） | 29.65 | 37.85 |
| /[slug]/+layout（招待あり） | 正順: token-notice（従） | 29.50 | 37.71 |
| /[slug]/+layout（招待あり） | 正順: invitation-list（従） | 12.64 | 16.89 |
| /[slug]/+layout（招待あり） | 正順: 合計（各試行の最終完了） | 43.48 | 50.72 |
| /[slug]/+layout（招待あり） | 正順: 従と主の完了差（診断値） | 12.76 | 16.94 |
| /[slug]/+layout（招待あり） | 逆順: organization（主） | 28.67 | 39.98 |
| /[slug]/+layout（招待あり） | 逆順: my-organizations（主） | 28.82 | 39.95 |
| /[slug]/+layout（招待あり） | 逆順: token-notice（従） | 8.38 | 11.63 |
| /[slug]/+layout（招待あり） | 逆順: invitation-list（従） | 11.55 | 17.22 |
| /[slug]/+layout（招待あり） | 逆順: 合計（各試行の最終完了） | 42.08 | 52.94 |
| /[slug]/+layout（招待あり） | 逆順: 従と主の完了差（診断値） | 11.60 | 17.26 |
| /[slug]/+layout（招待あり） | 並列の従: 判定不能 / 逐次の従: 構造上の候補 | — | — |
| /[slug] | 正順: today（主） | 33.66 | 48.74 |
| /[slug] | 正順: first-steps（従） | 46.53 | 60.28 |
| /[slug] | 正順: 合計（各試行の最終完了） | 47.63 | 60.54 |
| /[slug] | 正順: 従と主の完了差（診断値） | 13.97 | 23.19 |
| /[slug] | 逆順: today（主） | 51.44 | 123.66 |
| /[slug] | 逆順: first-steps（従） | 23.79 | 74.04 |
| /[slug] | 逆順: 合計（各試行の最終完了） | 51.66 | 123.99 |
| /[slug] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug] | 並列の従: 判定不能 | — | — |
| /[slug]/admin | 操作なし | — | — |
| /[slug]/invitations | 正順: invitation-list（主） | 11.62 | 12.79 |
| /[slug]/invitations | 正順: 合計（各試行の最終完了） | 11.64 | 12.81 |
| /[slug]/invitations | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/invitations | 逆順: invitation-list（主） | 12.60 | 14.87 |
| /[slug]/invitations | 逆順: 合計（各試行の最終完了） | 12.68 | 14.89 |
| /[slug]/invitations | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/invitations | 従なし | — | — |
| /[slug]/me | 正順: experience-summary（主） | 14.61 | 42.20 |
| /[slug]/me | 正順: experience-grants（主） | 40.58 | 52.81 |
| /[slug]/me | 正順: token-list（主） | 40.46 | 52.78 |
| /[slug]/me | 正順: invitation-list（主） | 39.91 | 50.39 |
| /[slug]/me | 正順: me（主） | 39.93 | 50.21 |
| /[slug]/me | 正順: 合計（各試行の最終完了） | 40.79 | 53.06 |
| /[slug]/me | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/me | 逆順: experience-summary（主） | 39.38 | 46.04 |
| /[slug]/me | 逆順: experience-grants（主） | 39.30 | 46.02 |
| /[slug]/me | 逆順: token-list（主） | 39.22 | 46.13 |
| /[slug]/me | 逆順: invitation-list（主） | 38.91 | 46.20 |
| /[slug]/me | 逆順: me（主） | 8.11 | 40.03 |
| /[slug]/me | 逆順: 合計（各試行の最終完了） | 39.69 | 46.38 |
| /[slug]/me | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/me | 従なし | — | — |
| /[slug]/w/[id]/+layout | 正順: workspace（主） | 10.89 | 14.95 |
| /[slug]/w/[id]/+layout | 正順: 合計（各試行の最終完了） | 10.91 | 14.98 |
| /[slug]/w/[id]/+layout | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/+layout | 逆順: workspace（主） | 10.93 | 17.66 |
| /[slug]/w/[id]/+layout | 逆順: 合計（各試行の最終完了） | 10.96 | 17.68 |
| /[slug]/w/[id]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/+layout | 従なし | — | — |
| /[slug]/w/[id] | 正順: backlog-tree（主） | 36.08 | 54.66 |
| /[slug]/w/[id] | 正順: category-repository-list（従） | 53.28 | 58.16 |
| /[slug]/w/[id] | 正順: experience-team-total（従） | 53.29 | 58.11 |
| /[slug]/w/[id] | 正順: 合計（各試行の最終完了） | 53.78 | 61.92 |
| /[slug]/w/[id] | 正順: 従と主の完了差（診断値） | 17.01 | 19.99 |
| /[slug]/w/[id] | 逆順: backlog-tree（主） | 54.01 | 62.09 |
| /[slug]/w/[id] | 逆順: category-repository-list（従） | 52.42 | 60.62 |
| /[slug]/w/[id] | 逆順: experience-team-total（従） | 13.88 | 51.39 |
| /[slug]/w/[id] | 逆順: 合計（各試行の最終完了） | 54.28 | 62.37 |
| /[slug]/w/[id] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id] | 並列の従: 判定不能 | — | — |
| /[slug]/w/[id]/plan | 正順: sprint-list（主） | 13.85 | 16.65 |
| /[slug]/w/[id]/plan | 正順: plan-summary（従） | 28.36 | 33.13 |
| /[slug]/w/[id]/plan | 正順: 合計（各試行の最終完了） | 28.50 | 33.31 |
| /[slug]/w/[id]/plan | 正順: 従と主の完了差（診断値） | 14.11 | 18.13 |
| /[slug]/w/[id]/plan | 逆順: sprint-list（主） | 29.01 | 33.71 |
| /[slug]/w/[id]/plan | 逆順: plan-summary（従） | 16.91 | 22.33 |
| /[slug]/w/[id]/plan | 逆順: 合計（各試行の最終完了） | 29.37 | 33.88 |
| /[slug]/w/[id]/plan | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/plan | 並列の従: 判定不能 | — | — |
| /[slug]/w/[id]/sprint | 正順: sprint-board（主） | 13.64 | 16.41 |
| /[slug]/w/[id]/sprint | 正順: 合計（各試行の最終完了） | 13.66 | 16.43 |
| /[slug]/w/[id]/sprint | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/sprint | 逆順: sprint-board（主） | 15.01 | 17.34 |
| /[slug]/w/[id]/sprint | 逆順: 合計（各試行の最終完了） | 15.03 | 17.37 |
| /[slug]/w/[id]/sprint | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/sprint | 従なし | — | — |
| /[slug]/w/[id]/settings | 正順: category-repository-list（主） | 12.39 | 18.65 |
| /[slug]/w/[id]/settings | 正順: column-list（主） | 32.21 | 40.77 |
| /[slug]/w/[id]/settings | 正順: detail-field-list（主） | 32.12 | 40.77 |
| /[slug]/w/[id]/settings | 正順: 合計（各試行の最終完了） | 32.40 | 40.99 |
| /[slug]/w/[id]/settings | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/settings | 逆順: category-repository-list（主） | 32.20 | 38.46 |
| /[slug]/w/[id]/settings | 逆順: column-list（主） | 32.21 | 38.44 |
| /[slug]/w/[id]/settings | 逆順: detail-field-list（主） | 12.61 | 16.47 |
| /[slug]/w/[id]/settings | 逆順: 合計（各試行の最終完了） | 32.57 | 38.76 |
| /[slug]/w/[id]/settings | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/settings | 従なし | — | — |
| /[slug]/w/[id]/members | 正順: member-list（主） | 17.44 | 21.26 |
| /[slug]/w/[id]/members | 正順: 合計（各試行の最終完了） | 17.47 | 21.29 |
| /[slug]/w/[id]/members | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/members | 逆順: member-list（主） | 17.93 | 25.59 |
| /[slug]/w/[id]/members | 逆順: 合計（各試行の最終完了） | 17.96 | 25.62 |
| /[slug]/w/[id]/members | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/members | 従なし | — | — |
| /[slug]/w/[id]/inbox | 正順: inbox-list（主） | 13.46 | 17.48 |
| /[slug]/w/[id]/inbox | 正順: 合計（各試行の最終完了） | 13.48 | 17.50 |
| /[slug]/w/[id]/inbox | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/inbox | 逆順: inbox-list（主） | 13.67 | 18.57 |
| /[slug]/w/[id]/inbox | 逆順: 合計（各試行の最終完了） | 13.69 | 18.60 |
| /[slug]/w/[id]/inbox | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/inbox | 従なし | — | — |
| /[slug]/w/[id]/connections | 正順: connection-list（主） | 11.61 | 15.38 |
| /[slug]/w/[id]/connections | 正順: 合計（各試行の最終完了） | 11.71 | 15.40 |
| /[slug]/w/[id]/connections | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/connections | 逆順: connection-list（主） | 11.22 | 12.41 |
| /[slug]/w/[id]/connections | 逆順: 合計（各試行の最終完了） | 11.25 | 12.43 |
| /[slug]/w/[id]/connections | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/connections | 従なし | — | — |
| /[slug]/w/[id]/epics/[epicId] | 正順: epic-detail（主） | 12.55 | 20.70 |
| /[slug]/w/[id]/epics/[epicId] | 正順: category-repository-list（従） | 21.55 | 27.54 |
| /[slug]/w/[id]/epics/[epicId] | 正順: 合計（各試行の最終完了） | 21.76 | 27.70 |
| /[slug]/w/[id]/epics/[epicId] | 正順: 従と主の完了差（診断値） | 9.03 | 10.52 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: epic-detail（主） | 23.21 | 28.06 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: category-repository-list（従） | 11.46 | 15.56 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: 合計（各試行の最終完了） | 23.44 | 28.32 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/epics/[epicId] | 並列の従: 判定不能 | — | — |
| /[slug]/wiki | 正順: org-wiki-tree（主） | 9.91 | 12.59 |
| /[slug]/wiki | 正順: 合計（各試行の最終完了） | 9.93 | 12.62 |
| /[slug]/wiki | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki | 逆順: org-wiki-tree（主） | 10.32 | 18.31 |
| /[slug]/wiki | 逆順: 合計（各試行の最終完了） | 10.33 | 18.33 |
| /[slug]/wiki | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki | 従なし | — | — |
| /[slug]/wiki/[pageId] | 正順: org-wiki-tree（主） | 10.42 | 13.08 |
| /[slug]/wiki/[pageId] | 正順: org-wiki-page（主） | 17.82 | 20.39 |
| /[slug]/wiki/[pageId] | 正順: 合計（各試行の最終完了） | 18.00 | 20.58 |
| /[slug]/wiki/[pageId] | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki/[pageId] | 逆順: org-wiki-tree（主） | 18.74 | 21.79 |
| /[slug]/wiki/[pageId] | 逆順: org-wiki-page（主） | 9.87 | 16.08 |
| /[slug]/wiki/[pageId] | 逆順: 合計（各試行の最終完了） | 18.95 | 22.01 |
| /[slug]/wiki/[pageId] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki/[pageId] | 従なし | — | — |
| /[slug]/w/[id]/wiki | 正順: workspace-wiki-tree（主） | 11.02 | 18.22 |
| /[slug]/w/[id]/wiki | 正順: 合計（各試行の最終完了） | 11.06 | 18.24 |
| /[slug]/w/[id]/wiki | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki | 逆順: workspace-wiki-tree（主） | 10.36 | 12.59 |
| /[slug]/w/[id]/wiki | 逆順: 合計（各試行の最終完了） | 10.39 | 13.12 |
| /[slug]/w/[id]/wiki | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki | 従なし | — | — |
| /[slug]/w/[id]/wiki/[pageId] | 正順: workspace-wiki-tree（主） | 11.02 | 20.77 |
| /[slug]/w/[id]/wiki/[pageId] | 正順: workspace-wiki-page（主） | 20.26 | 29.92 |
| /[slug]/w/[id]/wiki/[pageId] | 正順: 合計（各試行の最終完了） | 20.63 | 30.22 |
| /[slug]/w/[id]/wiki/[pageId] | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: workspace-wiki-tree（主） | 21.39 | 30.03 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: workspace-wiki-page（主） | 11.66 | 16.76 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: 合計（各試行の最終完了） | 21.61 | 30.22 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki/[pageId] | 従なし | — | — |

## 2回目の全結果

| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| / | 正順: my-organizations（主） | 14.59 | 17.92 |
| / | 正順: 合計（各試行の最終完了） | 14.60 | 17.94 |
| / | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| / | 逆順: my-organizations（主） | 14.09 | 16.85 |
| / | 逆順: 合計（各試行の最終完了） | 14.10 | 16.86 |
| / | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| / | 従なし | — | — |
| /auth/setup | 正順: onboarding-status（主） | 9.59 | 16.05 |
| /auth/setup | 正順: me（主） | 14.26 | 17.23 |
| /auth/setup | 正順: 合計（各試行の最終完了） | 14.61 | 17.53 |
| /auth/setup | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /auth/setup | 逆順: onboarding-status（主） | 16.44 | 20.09 |
| /auth/setup | 逆順: me（主） | 8.29 | 10.06 |
| /auth/setup | 逆順: 合計（各試行の最終完了） | 16.76 | 20.38 |
| /auth/setup | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /auth/setup | 従なし | — | — |
| /operator | 正順: list-organizations（主） | 16.71 | 21.77 |
| /operator | 正順: 合計（各試行の最終完了） | 16.72 | 21.78 |
| /operator | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /operator | 逆順: list-organizations（主） | 13.84 | 16.67 |
| /operator | 逆順: 合計（各試行の最終完了） | 13.85 | 16.67 |
| /operator | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /operator | 従なし | — | — |
| /[slug]/+layout | 正順: organization（主） | 13.45 | 16.34 |
| /[slug]/+layout | 正順: my-organizations（主） | 29.91 | 32.75 |
| /[slug]/+layout | 正順: token-notice（従） | 29.85 | 32.71 |
| /[slug]/+layout | 正順: 合計（各試行の最終完了） | 30.21 | 33.07 |
| /[slug]/+layout | 正順: 従と主の完了差（診断値） | 0.05 | 0.13 |
| /[slug]/+layout | 逆順: organization（主） | 28.45 | 33.63 |
| /[slug]/+layout | 逆順: my-organizations（主） | 28.58 | 33.65 |
| /[slug]/+layout | 逆順: token-notice（従） | 8.94 | 31.69 |
| /[slug]/+layout | 逆順: 合計（各試行の最終完了） | 28.78 | 33.96 |
| /[slug]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/+layout | 並列の従: 判定不能 | — | — |
| /[slug]/+layout（招待あり） | 正順: organization（主） | 12.65 | 33.73 |
| /[slug]/+layout（招待あり） | 正順: my-organizations（主） | 27.81 | 34.92 |
| /[slug]/+layout（招待あり） | 正順: token-notice（従） | 27.75 | 34.89 |
| /[slug]/+layout（招待あり） | 正順: invitation-list（従） | 11.83 | 13.55 |
| /[slug]/+layout（招待あり） | 正順: 合計（各試行の最終完了） | 39.43 | 47.81 |
| /[slug]/+layout（招待あり） | 正順: 従と主の完了差（診断値） | 11.93 | 13.60 |
| /[slug]/+layout（招待あり） | 逆順: organization（主） | 29.45 | 35.65 |
| /[slug]/+layout（招待あり） | 逆順: my-organizations（主） | 29.55 | 35.77 |
| /[slug]/+layout（招待あり） | 逆順: token-notice（従） | 9.93 | 24.40 |
| /[slug]/+layout（招待あり） | 逆順: invitation-list（従） | 12.54 | 16.05 |
| /[slug]/+layout（招待あり） | 逆順: 合計（各試行の最終完了） | 44.71 | 50.81 |
| /[slug]/+layout（招待あり） | 逆順: 従と主の完了差（診断値） | 12.59 | 16.17 |
| /[slug]/+layout（招待あり） | 並列の従: 判定不能 / 逐次の従: 構造上の候補 | — | — |
| /[slug] | 正順: today（主） | 28.19 | 34.79 |
| /[slug] | 正順: first-steps（従） | 40.15 | 47.99 |
| /[slug] | 正順: 合計（各試行の最終完了） | 40.49 | 48.31 |
| /[slug] | 正順: 従と主の完了差（診断値） | 12.72 | 15.82 |
| /[slug] | 逆順: today（主） | 44.05 | 52.84 |
| /[slug] | 逆順: first-steps（従） | 18.73 | 25.53 |
| /[slug] | 逆順: 合計（各試行の最終完了） | 44.31 | 53.27 |
| /[slug] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug] | 並列の従: 判定不能 | — | — |
| /[slug]/admin | 操作なし | — | — |
| /[slug]/invitations | 正順: invitation-list（主） | 11.30 | 15.41 |
| /[slug]/invitations | 正順: 合計（各試行の最終完了） | 11.33 | 15.44 |
| /[slug]/invitations | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/invitations | 逆順: invitation-list（主） | 11.52 | 13.74 |
| /[slug]/invitations | 逆順: 合計（各試行の最終完了） | 11.56 | 13.77 |
| /[slug]/invitations | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/invitations | 従なし | — | — |
| /[slug]/me | 正順: experience-summary（主） | 13.19 | 42.19 |
| /[slug]/me | 正順: experience-grants（主） | 40.61 | 46.59 |
| /[slug]/me | 正順: token-list（主） | 40.57 | 46.47 |
| /[slug]/me | 正順: invitation-list（主） | 41.10 | 46.50 |
| /[slug]/me | 正順: me（主） | 41.03 | 46.34 |
| /[slug]/me | 正順: 合計（各試行の最終完了） | 41.49 | 46.82 |
| /[slug]/me | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/me | 逆順: experience-summary（主） | 38.92 | 45.50 |
| /[slug]/me | 逆順: experience-grants（主） | 39.01 | 45.50 |
| /[slug]/me | 逆順: token-list（主） | 38.93 | 45.52 |
| /[slug]/me | 逆順: invitation-list（主） | 39.01 | 45.62 |
| /[slug]/me | 逆順: me（主） | 7.11 | 14.08 |
| /[slug]/me | 逆順: 合計（各試行の最終完了） | 39.31 | 45.92 |
| /[slug]/me | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/me | 従なし | — | — |
| /[slug]/w/[id]/+layout | 正順: workspace（主） | 10.87 | 12.94 |
| /[slug]/w/[id]/+layout | 正順: 合計（各試行の最終完了） | 10.90 | 12.97 |
| /[slug]/w/[id]/+layout | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/+layout | 逆順: workspace（主） | 11.33 | 21.73 |
| /[slug]/w/[id]/+layout | 逆順: 合計（各試行の最終完了） | 11.36 | 21.76 |
| /[slug]/w/[id]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/+layout | 従なし | — | — |
| /[slug]/w/[id] | 正順: backlog-tree（主） | 35.18 | 46.65 |
| /[slug]/w/[id] | 正順: category-repository-list（従） | 52.07 | 63.26 |
| /[slug]/w/[id] | 正順: experience-team-total（従） | 52.04 | 63.24 |
| /[slug]/w/[id] | 正順: 合計（各試行の最終完了） | 52.40 | 63.54 |
| /[slug]/w/[id] | 正順: 従と主の完了差（診断値） | 16.44 | 18.65 |
| /[slug]/w/[id] | 逆順: backlog-tree（主） | 53.26 | 56.56 |
| /[slug]/w/[id] | 逆順: category-repository-list（従） | 51.70 | 54.78 |
| /[slug]/w/[id] | 逆順: experience-team-total（従） | 13.83 | 27.23 |
| /[slug]/w/[id] | 逆順: 合計（各試行の最終完了） | 53.62 | 56.93 |
| /[slug]/w/[id] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id] | 並列の従: 判定不能 | — | — |
| /[slug]/w/[id]/plan | 正順: sprint-list（主） | 14.37 | 18.40 |
| /[slug]/w/[id]/plan | 正順: plan-summary（従） | 28.89 | 37.38 |
| /[slug]/w/[id]/plan | 正順: 合計（各試行の最終完了） | 29.34 | 37.58 |
| /[slug]/w/[id]/plan | 正順: 従と主の完了差（診断値） | 14.97 | 22.32 |
| /[slug]/w/[id]/plan | 逆順: sprint-list（主） | 26.43 | 30.14 |
| /[slug]/w/[id]/plan | 逆順: plan-summary（従） | 15.99 | 25.66 |
| /[slug]/w/[id]/plan | 逆順: 合計（各試行の最終完了） | 26.66 | 30.34 |
| /[slug]/w/[id]/plan | 逆順: 従と主の完了差（診断値） | 0.00 | 0.05 |
| /[slug]/w/[id]/plan | 並列の従: 判定不能 | — | — |
| /[slug]/w/[id]/sprint | 正順: sprint-board（主） | 13.34 | 19.53 |
| /[slug]/w/[id]/sprint | 正順: 合計（各試行の最終完了） | 13.36 | 19.56 |
| /[slug]/w/[id]/sprint | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/sprint | 逆順: sprint-board（主） | 13.12 | 17.17 |
| /[slug]/w/[id]/sprint | 逆順: 合計（各試行の最終完了） | 13.15 | 17.20 |
| /[slug]/w/[id]/sprint | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/sprint | 従なし | — | — |
| /[slug]/w/[id]/settings | 正順: category-repository-list（主） | 11.76 | 36.17 |
| /[slug]/w/[id]/settings | 正順: column-list（主） | 28.46 | 46.71 |
| /[slug]/w/[id]/settings | 正順: detail-field-list（主） | 28.43 | 46.50 |
| /[slug]/w/[id]/settings | 正順: 合計（各試行の最終完了） | 28.65 | 47.92 |
| /[slug]/w/[id]/settings | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/settings | 逆順: category-repository-list（主） | 29.33 | 35.24 |
| /[slug]/w/[id]/settings | 逆順: column-list（主） | 29.33 | 35.24 |
| /[slug]/w/[id]/settings | 逆順: detail-field-list（主） | 11.49 | 13.76 |
| /[slug]/w/[id]/settings | 逆順: 合計（各試行の最終完了） | 29.59 | 35.52 |
| /[slug]/w/[id]/settings | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/settings | 従なし | — | — |
| /[slug]/w/[id]/members | 正順: member-list（主） | 16.07 | 20.05 |
| /[slug]/w/[id]/members | 正順: 合計（各試行の最終完了） | 16.10 | 20.09 |
| /[slug]/w/[id]/members | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/members | 逆順: member-list（主） | 15.92 | 18.45 |
| /[slug]/w/[id]/members | 逆順: 合計（各試行の最終完了） | 15.95 | 18.47 |
| /[slug]/w/[id]/members | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/members | 従なし | — | — |
| /[slug]/w/[id]/inbox | 正順: inbox-list（主） | 12.86 | 14.26 |
| /[slug]/w/[id]/inbox | 正順: 合計（各試行の最終完了） | 12.88 | 14.34 |
| /[slug]/w/[id]/inbox | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/inbox | 逆順: inbox-list（主） | 12.93 | 18.10 |
| /[slug]/w/[id]/inbox | 逆順: 合計（各試行の最終完了） | 12.96 | 18.13 |
| /[slug]/w/[id]/inbox | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/inbox | 従なし | — | — |
| /[slug]/w/[id]/connections | 正順: connection-list（主） | 10.54 | 13.04 |
| /[slug]/w/[id]/connections | 正順: 合計（各試行の最終完了） | 10.57 | 13.08 |
| /[slug]/w/[id]/connections | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/connections | 逆順: connection-list（主） | 10.31 | 12.13 |
| /[slug]/w/[id]/connections | 逆順: 合計（各試行の最終完了） | 10.33 | 12.16 |
| /[slug]/w/[id]/connections | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/connections | 従なし | — | — |
| /[slug]/w/[id]/epics/[epicId] | 正順: epic-detail（主） | 11.99 | 18.05 |
| /[slug]/w/[id]/epics/[epicId] | 正順: category-repository-list（従） | 21.01 | 26.41 |
| /[slug]/w/[id]/epics/[epicId] | 正順: 合計（各試行の最終完了） | 21.20 | 26.69 |
| /[slug]/w/[id]/epics/[epicId] | 正順: 従と主の完了差（診断値） | 9.17 | 10.13 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: epic-detail（主） | 21.36 | 24.21 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: category-repository-list（従） | 11.20 | 18.90 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: 合計（各試行の最終完了） | 21.57 | 24.49 |
| /[slug]/w/[id]/epics/[epicId] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/epics/[epicId] | 並列の従: 判定不能 | — | — |
| /[slug]/wiki | 正順: org-wiki-tree（主） | 10.18 | 11.63 |
| /[slug]/wiki | 正順: 合計（各試行の最終完了） | 10.22 | 11.66 |
| /[slug]/wiki | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki | 逆順: org-wiki-tree（主） | 9.67 | 11.68 |
| /[slug]/wiki | 逆順: 合計（各試行の最終完了） | 9.80 | 11.70 |
| /[slug]/wiki | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki | 従なし | — | — |
| /[slug]/wiki/[pageId] | 正順: org-wiki-tree（主） | 11.03 | 16.12 |
| /[slug]/wiki/[pageId] | 正順: org-wiki-page（主） | 19.17 | 32.86 |
| /[slug]/wiki/[pageId] | 正順: 合計（各試行の最終完了） | 19.37 | 33.08 |
| /[slug]/wiki/[pageId] | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki/[pageId] | 逆順: org-wiki-tree（主） | 18.95 | 25.21 |
| /[slug]/wiki/[pageId] | 逆順: org-wiki-page（主） | 10.18 | 11.75 |
| /[slug]/wiki/[pageId] | 逆順: 合計（各試行の最終完了） | 19.19 | 25.44 |
| /[slug]/wiki/[pageId] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/wiki/[pageId] | 従なし | — | — |
| /[slug]/w/[id]/wiki | 正順: workspace-wiki-tree（主） | 11.07 | 14.28 |
| /[slug]/w/[id]/wiki | 正順: 合計（各試行の最終完了） | 11.12 | 14.32 |
| /[slug]/w/[id]/wiki | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki | 逆順: workspace-wiki-tree（主） | 10.66 | 18.18 |
| /[slug]/w/[id]/wiki | 逆順: 合計（各試行の最終完了） | 10.69 | 18.21 |
| /[slug]/w/[id]/wiki | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki | 従なし | — | — |
| /[slug]/w/[id]/wiki/[pageId] | 正順: workspace-wiki-tree（主） | 11.33 | 23.47 |
| /[slug]/w/[id]/wiki/[pageId] | 正順: workspace-wiki-page（主） | 18.95 | 23.36 |
| /[slug]/w/[id]/wiki/[pageId] | 正順: 合計（各試行の最終完了） | 19.16 | 23.54 |
| /[slug]/w/[id]/wiki/[pageId] | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: workspace-wiki-tree（主） | 20.60 | 25.68 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: workspace-wiki-page（主） | 11.63 | 24.52 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: 合計（各試行の最終完了） | 21.10 | 25.87 |
| /[slug]/w/[id]/wiki/[pageId] | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/w/[id]/wiki/[pageId] | 従なし | — | — |
