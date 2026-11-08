# 実装の受け入れ条件

受け入れ条件は次のとおり。触る範囲に合わないものは外し、外した理由を渡す。

- 完了条件を確かめるテストを実装と一緒に書く。API の操作を足したら、権限と組織の分離のテストが通る（`add-operation`）。「テストを先に書く」を行ったときは、実装前に保存したテストのファイルを変えずにすべて通す（足りないテストは足してよい）。テストが誤っていると見たら、変えずに、どのテストのどこが Issue と `docs/` のどれに合わないかを添えて戻る
- 仕様を変えたら、同じ差分で `docs/` を直す
- Issue と `docs/` に無い判断を置いたら、報告に根拠付きで並べる
- アプリのコード・依存・ビルド設定の変更は `pnpm check`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build` が通る。文書・スキルだけなら、変更ファイルの整形、リンク・参照節・メタデータ・設定構文と、影響する手順のテストを確かめる。検査の再利用は [validation.md](validation.md) に従う
- マイグレーションを足したら `pnpm db:migrate:fresh` が通る（書き方は `d1-migration`）
- 画面か API の流れを変えたら、変えた画面と流れを開く e2e のテストを差分に足し、ローカルでは走らせない。クラウドでは PR 前に `pnpm e2e:preflight [base-ref] --files … --reason …` を通す（`docs/development.md` の「クラウドで PR 前に e2e を確かめる」。`e2e:preflight` が Playwright が無いとして終了コード 3 を返したときだけ省いて CI で担保する）。PR の CI も省略せず（`e2e`、`e2e-dev`、`e2e-repeat`）で確かめる。落ちたときの直し方は `docs/development.md` の「CI の e2e が落ちたとき」に従う
- `.claude/hooks/` を変えたら `node --test .claude/hooks/*.test.mjs` が通る

API の追加は `add-operation`、マイグレーションは `d1-migration`、画面は `docs/design.md` を基準にし、動きを足したときだけ `review-animations` を読む。委譲時はワークツリー、目的、完了条件、担当範囲、該当する受け入れ条件と必要なスキルの絶対パスを渡す。他の作業を戻さず、範囲を超える必要があれば報告する。

Issue が無い直接依頼では、会話で整理した目的・完了条件・判断を使い、委譲先に番号は「無し」と渡す。
