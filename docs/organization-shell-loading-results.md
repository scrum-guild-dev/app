# 組織の枠の読み込みの変更と再計測（#1054）

2026-11-14（日本時間）に HEAD `3dbf055` を基準とする未コミットの実装で計測した。Node 26.13.1、pnpm 12.12.0、Wrangler 4.153.0。使い捨てのローカル D1 に同じ seed と loading-fixture を流し、各条件・発行順で温め2回、計測20回。1回目の変更前→変更後、2回目の変更前→変更後の順で、他の build・テストとは重ねず実行した。各実行の D1 は終了時に削除した。

## 実装と比較の条件

load が始めた Promise を返す方式を選んだ。部品で初めて API を呼ぶ方式と比べ、通知の要求を主と並行して始められ、枠の読み直しでは新しい Promise に切り替わる。通知の部品は主の表示からマウントし、初回応答の保留中も同組織内の移動で通知を読み直す。招待件数は組織に入れる人だけ従とし、通知を待たず主の群の完了後に要求する。広い幅・狭い幅のメニューは同じ件数と再試行状態を共有する。招待だけの人の一覧は主のまま。

比較する操作は `organization`、`my-organizations`、`favorite-list`、`token-notice` と、招待ありの `invitation-list`。変更前は最初の4操作と、その後の件数をすべて待つ。変更後は通知を先に開始し、主の3操作が済めば枠を返し、件数は主の完了後に開始する。逆順の試行は最初の群の発行順だけを逆にする。出力スキーマの検査は両方式とも全応答の後に行う。

```sh
pnpm bench:loading --layout-only --layout-before
pnpm bench:loading --layout-only
```

`--layout-only` は組織の枠の通常・招待ありだけを選ぶ。`--layout-before` はその2行で変更前の発行・待ち順を再現する比較用の指定。通常の全画面計測も、この2行では変更後の待ち順を使う。操作表の注記は現行実装の説明であり、変更前の比較実行の待ち順は上の説明による。

## 枠を返せる時点

単位 ms、各セルは p50 / p95（nearest-rank）。

| 回 | 枠 | 発行順 | 変更前 | 変更後 |
| --- | --- | --- | ---: | ---: |
| 1 | `/[slug]/+layout` | 正順 | 45.23 / 52.22 | 49.80 / 58.59 |
| 1 | `/[slug]/+layout` | 逆順 | 40.90 / 60.96 | 51.02 / 59.47 |
| 1 | `/[slug]/+layout（招待あり）` | 正順 | 59.74 / 68.56 | 42.64 / 51.20 |
| 1 | `/[slug]/+layout（招待あり）` | 逆順 | 58.34 / 75.65 | 47.86 / 63.86 |
| 2 | `/[slug]/+layout` | 正順 | 51.00 / 64.78 | 40.63 / 52.25 |
| 2 | `/[slug]/+layout` | 逆順 | 43.63 / 49.08 | 45.87 / 54.78 |
| 2 | `/[slug]/+layout（招待あり）` | 正順 | 54.83 / 62.89 | 39.46 / 48.19 |
| 2 | `/[slug]/+layout（招待あり）` | 逆順 | 52.29 / 59.98 | 42.48 / 47.08 |

招待ありでは両回・両順で枠を返せる時点が早まった。一方、招待なしは悪化する試行もあり、一律に改善したとはいえない。ローカル Worker/D1 の直列処理、発行順・キャッシュ・時間経過の影響があり、並列の通知の効果だけを分離した値ではない。計測器は API の往復と依存関係を再現するもので、SvelteKit の描画・ブラウザ・本番回線を測っていない。実際の load が従の応答を待たないことは保留した fetch を使うユニットテストで確認する。画面の動作は E2E を追加し、通常・開発・繰り返しの実行は CI に委ねる。

旧計測の診断値を今回の改善量として扱わない。下の「合計」は従も含む全応答の完了で、変更後の主の表示時点とは異なる。「従と主の完了差」は引き続き診断値であり、本番の短縮量ではない。

## 1回目・変更前

Node v26.13.1、各画面・発行順ごと warmup 2 回 + 20 回（正順・逆順）。時間は API 往復 ms。分位点は nearest-rank。
| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| /[slug]/+layout | 正順: organization（主） | 16.50 | 25.50 |
| /[slug]/+layout | 正順: my-organizations（主） | 43.55 | 51.59 |
| /[slug]/+layout | 正順: token-notice（従） | 44.52 | 51.42 |
| /[slug]/+layout | 正順: favorite-list（主） | 44.61 | 51.30 |
| /[slug]/+layout | 正順: 枠を返せる時点（変更前） | 45.23 | 52.22 |
| /[slug]/+layout | 正順: 合計（各試行の最終完了） | 45.23 | 52.22 |
| /[slug]/+layout | 正順: 従と主の完了差（診断値） | 0.00 | 0.04 |
| /[slug]/+layout | 逆順: organization（主） | 40.50 | 60.40 |
| /[slug]/+layout | 逆順: my-organizations（主） | 40.53 | 60.15 |
| /[slug]/+layout | 逆順: token-notice（従） | 39.60 | 60.27 |
| /[slug]/+layout | 逆順: favorite-list（主） | 12.82 | 32.25 |
| /[slug]/+layout | 逆順: 枠を返せる時点（変更前） | 40.90 | 60.96 |
| /[slug]/+layout | 逆順: 合計（各試行の最終完了） | 40.90 | 60.96 |
| /[slug]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.09 |
| /[slug]/+layout | 並列の従: 判定不能 | — | — |
| /[slug]/+layout（招待あり） | 正順: organization（主） | 16.08 | 44.73 |
| /[slug]/+layout（招待あり） | 正順: my-organizations（主） | 42.71 | 49.68 |
| /[slug]/+layout（招待あり） | 正順: token-notice（従） | 42.68 | 49.67 |
| /[slug]/+layout（招待あり） | 正順: favorite-list（主） | 42.64 | 49.65 |
| /[slug]/+layout（招待あり） | 正順: invitation-list（従） | 13.68 | 19.05 |
| /[slug]/+layout（招待あり） | 正順: 枠を返せる時点（変更前） | 59.74 | 68.56 |
| /[slug]/+layout（招待あり） | 正順: 合計（各試行の最終完了） | 59.74 | 68.56 |
| /[slug]/+layout（招待あり） | 正順: 従と主の完了差（診断値） | 13.73 | 19.10 |
| /[slug]/+layout（招待あり） | 逆順: organization（主） | 42.28 | 62.11 |
| /[slug]/+layout（招待あり） | 逆順: my-organizations（主） | 42.28 | 62.11 |
| /[slug]/+layout（招待あり） | 逆順: token-notice（従） | 42.28 | 62.27 |
| /[slug]/+layout（招待あり） | 逆順: favorite-list（主） | 13.77 | 17.56 |
| /[slug]/+layout（招待あり） | 逆順: invitation-list（従） | 13.38 | 16.34 |
| /[slug]/+layout（招待あり） | 逆順: 枠を返せる時点（変更前） | 58.34 | 75.65 |
| /[slug]/+layout（招待あり） | 逆順: 合計（各試行の最終完了） | 58.34 | 75.65 |
| /[slug]/+layout（招待あり） | 逆順: 従と主の完了差（診断値） | 13.52 | 16.52 |
| /[slug]/+layout（招待あり） | 並列の従: 判定不能 / 逐次の従: 構造上の候補 | — | — |

/[slug]/+layout（招待あり）: 主の群の完了後に招待件数を開始し、通知・件数の完了は枠の表示を待たせない。招待だけの人の一覧は主として待つ別経路。

## 1回目・変更後

Node v26.13.1、各画面・発行順ごと warmup 2 回 + 20 回（正順・逆順）。時間は API 往復 ms。分位点は nearest-rank。
| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| /[slug]/+layout | 正順: token-notice（従） | 12.04 | 26.61 |
| /[slug]/+layout | 正順: organization（主） | 49.14 | 58.31 |
| /[slug]/+layout | 正順: my-organizations（主） | 49.39 | 57.95 |
| /[slug]/+layout | 正順: favorite-list（主） | 49.24 | 57.94 |
| /[slug]/+layout | 正順: 枠を返せる時点（変更後） | 49.80 | 58.59 |
| /[slug]/+layout | 正順: 合計（各試行の最終完了） | 49.80 | 58.59 |
| /[slug]/+layout | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/+layout | 逆順: token-notice（従） | 50.12 | 58.39 |
| /[slug]/+layout | 逆順: organization（主） | 50.48 | 58.75 |
| /[slug]/+layout | 逆順: my-organizations（主） | 50.64 | 58.86 |
| /[slug]/+layout | 逆順: favorite-list（主） | 15.37 | 22.87 |
| /[slug]/+layout | 逆順: 枠を返せる時点（変更後） | 51.02 | 59.47 |
| /[slug]/+layout | 逆順: 合計（各試行の最終完了） | 51.02 | 59.47 |
| /[slug]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.07 |
| /[slug]/+layout | 並列の従: 判定不能 | — | — |
| /[slug]/+layout（招待あり） | 正順: token-notice（従） | 11.66 | 44.61 |
| /[slug]/+layout（招待あり） | 正順: organization（主） | 42.25 | 50.85 |
| /[slug]/+layout（招待あり） | 正順: my-organizations（主） | 42.29 | 50.68 |
| /[slug]/+layout（招待あり） | 正順: favorite-list（主） | 42.18 | 50.76 |
| /[slug]/+layout（招待あり） | 正順: invitation-list（従） | 14.25 | 19.56 |
| /[slug]/+layout（招待あり） | 正順: 枠を返せる時点（変更後） | 42.64 | 51.20 |
| /[slug]/+layout（招待あり） | 正順: 合計（各試行の最終完了） | 55.95 | 73.39 |
| /[slug]/+layout（招待あり） | 正順: 従と主の完了差（診断値） | 14.29 | 19.63 |
| /[slug]/+layout（招待あり） | 逆順: token-notice（従） | 47.29 | 63.22 |
| /[slug]/+layout（招待あり） | 逆順: organization（主） | 47.52 | 63.42 |
| /[slug]/+layout（招待あり） | 逆順: my-organizations（主） | 46.70 | 63.58 |
| /[slug]/+layout（招待あり） | 逆順: favorite-list（主） | 13.91 | 51.85 |
| /[slug]/+layout（招待あり） | 逆順: invitation-list（従） | 13.47 | 16.98 |
| /[slug]/+layout（招待あり） | 逆順: 枠を返せる時点（変更後） | 47.86 | 63.86 |
| /[slug]/+layout（招待あり） | 逆順: 合計（各試行の最終完了） | 60.72 | 76.58 |
| /[slug]/+layout（招待あり） | 逆順: 従と主の完了差（診断値） | 13.53 | 17.10 |
| /[slug]/+layout（招待あり） | 並列の従: 判定不能 / 逐次の従: 構造上の候補 | — | — |

/[slug]/+layout（招待あり）: 主の群の完了後に招待件数を開始し、通知・件数の完了は枠の表示を待たせない。招待だけの人の一覧は主として待つ別経路。

## 2回目・変更前

Node v26.13.1、各画面・発行順ごと warmup 2 回 + 20 回（正順・逆順）。時間は API 往復 ms。分位点は nearest-rank。
| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| /[slug]/+layout | 正順: organization（主） | 18.24 | 46.79 |
| /[slug]/+layout | 正順: my-organizations（主） | 50.17 | 64.17 |
| /[slug]/+layout | 正順: token-notice（従） | 50.19 | 64.20 |
| /[slug]/+layout | 正順: favorite-list（主） | 50.35 | 64.13 |
| /[slug]/+layout | 正順: 枠を返せる時点（変更前） | 51.00 | 64.78 |
| /[slug]/+layout | 正順: 合計（各試行の最終完了） | 51.00 | 64.78 |
| /[slug]/+layout | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/+layout | 逆順: organization（主） | 42.88 | 48.64 |
| /[slug]/+layout | 逆順: my-organizations（主） | 42.92 | 48.71 |
| /[slug]/+layout | 逆順: token-notice（従） | 42.93 | 48.72 |
| /[slug]/+layout | 逆順: favorite-list（主） | 14.91 | 42.03 |
| /[slug]/+layout | 逆順: 枠を返せる時点（変更前） | 43.63 | 49.08 |
| /[slug]/+layout | 逆順: 合計（各試行の最終完了） | 43.63 | 49.08 |
| /[slug]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/+layout | 並列の従: 判定不能 | — | — |
| /[slug]/+layout（招待あり） | 正順: organization（主） | 15.08 | 36.11 |
| /[slug]/+layout（招待あり） | 正順: my-organizations（主） | 41.49 | 47.72 |
| /[slug]/+layout（招待あり） | 正順: token-notice（従） | 41.44 | 47.44 |
| /[slug]/+layout（招待あり） | 正順: favorite-list（主） | 41.44 | 47.15 |
| /[slug]/+layout（招待あり） | 正順: invitation-list（従） | 12.76 | 19.48 |
| /[slug]/+layout（招待あり） | 正順: 枠を返せる時点（変更前） | 54.83 | 62.89 |
| /[slug]/+layout（招待あり） | 正順: 合計（各試行の最終完了） | 54.83 | 62.89 |
| /[slug]/+layout（招待あり） | 正順: 従と主の完了差（診断値） | 12.82 | 19.53 |
| /[slug]/+layout（招待あり） | 逆順: organization（主） | 39.46 | 46.56 |
| /[slug]/+layout（招待あり） | 逆順: my-organizations（主） | 39.49 | 46.54 |
| /[slug]/+layout（招待あり） | 逆順: token-notice（従） | 39.51 | 45.33 |
| /[slug]/+layout（招待あり） | 逆順: favorite-list（主） | 11.41 | 18.54 |
| /[slug]/+layout（招待あり） | 逆順: invitation-list（従） | 12.01 | 13.13 |
| /[slug]/+layout（招待あり） | 逆順: 枠を返せる時点（変更前） | 52.29 | 59.98 |
| /[slug]/+layout（招待あり） | 逆順: 合計（各試行の最終完了） | 52.29 | 59.98 |
| /[slug]/+layout（招待あり） | 逆順: 従と主の完了差（診断値） | 12.05 | 13.18 |
| /[slug]/+layout（招待あり） | 並列の従: 判定不能 / 逐次の従: 構造上の候補 | — | — |

/[slug]/+layout（招待あり）: 主の群の完了後に招待件数を開始し、通知・件数の完了は枠の表示を待たせない。招待だけの人の一覧は主として待つ別経路。

## 2回目・変更後

Node v26.13.1、各画面・発行順ごと warmup 2 回 + 20 回（正順・逆順）。時間は API 往復 ms。分位点は nearest-rank。
| load | 操作（主/従） | p50 ms | p95 ms |
| --- | --- | ---: | ---: |
| /[slug]/+layout | 正順: token-notice（従） | 10.89 | 13.26 |
| /[slug]/+layout | 正順: organization（主） | 40.22 | 51.97 |
| /[slug]/+layout | 正順: my-organizations（主） | 40.05 | 51.75 |
| /[slug]/+layout | 正順: favorite-list（主） | 40.15 | 51.55 |
| /[slug]/+layout | 正順: 枠を返せる時点（変更後） | 40.63 | 52.25 |
| /[slug]/+layout | 正順: 合計（各試行の最終完了） | 40.63 | 52.25 |
| /[slug]/+layout | 正順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/+layout | 逆順: token-notice（従） | 45.18 | 53.86 |
| /[slug]/+layout | 逆順: organization（主） | 45.39 | 54.28 |
| /[slug]/+layout | 逆順: my-organizations（主） | 45.47 | 54.09 |
| /[slug]/+layout | 逆順: favorite-list（主） | 13.84 | 17.31 |
| /[slug]/+layout | 逆順: 枠を返せる時点（変更後） | 45.87 | 54.78 |
| /[slug]/+layout | 逆順: 合計（各試行の最終完了） | 45.87 | 54.78 |
| /[slug]/+layout | 逆順: 従と主の完了差（診断値） | 0.00 | 0.00 |
| /[slug]/+layout | 並列の従: 判定不能 | — | — |
| /[slug]/+layout（招待あり） | 正順: token-notice（従） | 9.26 | 45.40 |
| /[slug]/+layout（招待あり） | 正順: organization（主） | 39.12 | 47.97 |
| /[slug]/+layout（招待あり） | 正順: my-organizations（主） | 38.95 | 47.79 |
| /[slug]/+layout（招待あり） | 正順: favorite-list（主） | 38.97 | 47.79 |
| /[slug]/+layout（招待あり） | 正順: invitation-list（従） | 13.46 | 17.65 |
| /[slug]/+layout（招待あり） | 正順: 枠を返せる時点（変更後） | 39.46 | 48.19 |
| /[slug]/+layout（招待あり） | 正順: 合計（各試行の最終完了） | 54.41 | 63.15 |
| /[slug]/+layout（招待あり） | 正順: 従と主の完了差（診断値） | 13.52 | 17.70 |
| /[slug]/+layout（招待あり） | 逆順: token-notice（従） | 42.30 | 46.68 |
| /[slug]/+layout（招待あり） | 逆順: organization（主） | 42.25 | 46.50 |
| /[slug]/+layout（招待あり） | 逆順: my-organizations（主） | 41.96 | 46.86 |
| /[slug]/+layout（招待あり） | 逆順: favorite-list（主） | 12.72 | 43.67 |
| /[slug]/+layout（招待あり） | 逆順: invitation-list（従） | 12.90 | 16.76 |
| /[slug]/+layout（招待あり） | 逆順: 枠を返せる時点（変更後） | 42.48 | 47.08 |
| /[slug]/+layout（招待あり） | 逆順: 合計（各試行の最終完了） | 56.48 | 60.06 |
| /[slug]/+layout（招待あり） | 逆順: 従と主の完了差（診断値） | 12.98 | 16.81 |
| /[slug]/+layout（招待あり） | 並列の従: 判定不能 / 逐次の従: 構造上の候補 | — | — |

/[slug]/+layout（招待あり）: 主の群の完了後に招待件数を開始し、通知・件数の完了は枠の表示を待たせない。招待だけの人の一覧は主として待つ別経路。
