---
name: done-check
description: 自分の実装を点検し、問題を修正する。セルフレビューや PR 前の点検に使う。指摘だけのレビューは対象外。
---

# done-check

## 仕事

自分の差分を点検し、レビュワーに渡す前に直せるものを直す。
PR 作成前と作成後の両方で使う。作成後は、PR が最新の状態にあることを確かめてから点検する。
指摘を並べて終わりにしない。直すところまでが仕事。

## 絶対にやらないこと

- 指摘を出して直さずに終わらない（理由: レビュワーに渡す前に潰すのがこの工程の目的）
- 差分に無い箇所をついでに直さない（理由: PR の差分が膨らみ、レビューの負荷が上がる）
- 変更に必要な検査を通さずに完了としない（理由: CI が落ちてからレビュワーを待たせる）

## GitHub の操作

PR の状態は `gh api` の REST で取る。クラウドのセッションでは、GraphQL を使う `gh pr` が 403 で止まるため。
`{owner}` `{repo}` `{branch}` は `gh` がカレントのリポジトリとブランチに置き換える。置き換わらずに 404 になるときは、`git remote get-url origin` と `git branch --show-current` から読んで直に書く。
`gh` が無いか認証で失敗するときは、`pr/github-mcp.md` に従い、GitHub の MCP ツールで代える。

## 入力

作業ブランチの差分。対象の Issue 番号が分かれば合わせて。

## 手順

### 0. PR の有無で分岐する

```bash
gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0] | {number, url: .html_url, base: .base.ref, head_sha: .head.sha}'
```

`number` が `null` なら PR は無い。手順 1 へ進む。ベースブランチは慣習（通常 `origin/main`）から決める。

PR があれば、ベースは `origin/<base>` とし、次の前提をすべて確認する。

| 前提 | 確認 | 満たすとき |
| --- | --- | --- |
| 最新のベースを取り込み済み | `git fetch origin && git merge-base --is-ancestor origin/<base> HEAD` | 終了コード 0 |
| 最新のコミットを push 済み | `git rev-parse HEAD` と `head_sha` を比べる。`git status --short` も見る | 一致し、未コミットの変更が無い |
| CI が成功 | 下の check-runs | `review` を除き、全て `status` が `completed` で、`conclusion` が `success`、`skipped`、`neutral` のどれか |
| レビューコメントを解決済み | 下の GraphQL | PR の作成者が書き、`pr` の目印が付いたコメントで始まるスレッドを除き、`isResolved: false` のスレッドが 0 件 |

```bash
gh api "repos/{owner}/{repo}/commits/<head_sha>/check-runs" --jq '.check_runs[] | {name, status, conclusion, url: .html_url}'
```

`review` は AI レビュー（`.github/workflows/ai-review.yml`）のチェックで、助言なので `ci-ok` に含めず、落ちてもマージの判定を止めない（`docs/development.md` の「CI」）。
`review` の `status` と `conclusion` が何でも、この前提は満たすものとして扱う（理由: 回した先の pr も `review` の失敗は直さないので、数に入れると done-check が先へ進めない）。
実行中の `review` が後から付ける指摘は、pr/feedback.md の手順 1 が完了を待って拾う。
PR 作成後の段では、`e2e`、`e2e-dev`、`e2e-repeat` の結果も確かめる。e2e はセッションが手元で走らせないので、これが e2e の確かめになる。この 3 つは `ci-ok` に含まれ、上の表の「CI が成功」で見る。落ちていたら、ローカルでは再現せずログと trace で直し、クラウドでは関連ファイルで再現して修正後に事前検査を通す。回した先の pr/feedback.md の手順 5 に従う（`docs/development.md` の「CI の e2e が落ちたとき」）。

```bash
gh api graphql -f query='{ repository(owner:"<owner>", name:"<repo>") { pullRequest(number:<number>) { author { login } reviewThreads(first:100) { nodes { isResolved path comments(first:1) { nodes { body author { login } } } } } } } }'
```

先頭コメントの本文に目印の `<!-- pr-create:guide -->` があり、かつその `author.login` が PR の `author.login` と同じスレッドは数えない（理由: `pr` がレビュワーへの案内として付けるインラインコメントも未解決のスレッドになり、数えると PR を作った後の done-check が止まる。作者だけで除くと、作者は人の本人のアカウントなので人が自分で付けた指摘まで数えなくなり、目印だけで除くと、公開リポジトリで誰でも目印を仕込んだ指摘を数えさせなくできる）。

スレッドの解決状態は GraphQL でしか取れない。403（クラウド）が返ったら、`gh api "repos/{owner}/{repo}/pulls/<number>/comments" --paginate` でレビューコメントを読み、同じ条件で除いて、自分の返信が付いていないスレッドの先頭を数える。この前提は「解決状態は確かめられなかった」と出力に書いて先へ進む。

満たさない前提が 1 つでもあれば、レビューに進まず止まり、満たさない前提と次の経路を出力する。

- ベースの取り込みが未了: `sync-base` で merge して通常の push をする
- push が未了: `git push` を提案する
- CI が失敗: pr で直す。`review` を除いて `status` が `completed` でないものがあれば、間を空けて check-runs を取り直し、結果が出てから再確認する
- 未解決のスレッドがある: pr で対応する

全て満たせば手順 1 へ進む。

### 1. 差分を確認する

```bash
git status --short
git diff <base>...HEAD
```

身に覚えのない変更があれば止まる（並行セッションの可能性）。

### 2. 完了条件と突き合わせる

[共通の点検基準](../../../docs/agent-workflows/review.md) の「完了条件と突き合わせる」に従う。範囲と判断の一覧を出力に残す。

### 3. 規約を読む

同じ文書の「規約を読む」に従う。既読で変更のない資料は読み直さない。

### 4. 機械で判定できるものを先に通す

[受け入れ条件](../../../docs/agent-workflows/acceptance.md) と [検査結果の再利用](../../../docs/agent-workflows/validation.md) に従い、未実施または入力状態が変わった検査を行う。

### 5. 動かして確かめる

共通の点検基準の「動かして確かめる」に従う。ローカルの画面確認には terminal-browser を使い、e2e は CI に任せる。クラウドでは PR 前に `pnpm e2e:preflight [base-ref]` を通し、対象コードと記録を確認する。CI も省略しない。

### 6. レビューエージェントに渡す

呼ぶエージェントは `.claude/skills/ai-review/reviewers.md` の表で決める。差分を「呼ぶとき」に当て、手元（done-check）の列で必要な役割を選ぶ。小変更は表の「手元の小変更」で役割を集約し、それ以外は必要なエージェントを同時に呼ぶ。

エージェントには範囲として「ベースは `<base>`。コミット済みの `git diff <base>...HEAD`（3点。分岐した点からの差分）と、未コミットの `git diff HEAD` と `git ls-files --others --exclude-standard` の新規ファイルを合わせて見る」と渡す。
範囲を渡さないと、エージェントは未コミットの差分しか見ない。
呼ぶ直前に `git rev-parse HEAD` の完全な SHA を控え、出力の「点検した head」に書く（理由: 出力を書くときに取ると、手順 7 の直しのコミットを含む head を点検済みにしうる）。2巡目を呼ぶときは、その直前に控え直し、出力には2巡目に渡した SHA を書く（1巡目の直しは2巡目が見ているので含めてよい。2巡目の後の直しは含めない）。
2点の `git diff <base>` と `git diff <base>..HEAD` は使わない（理由: どちらもベースの先端と比べるので、作業中にベースが進むと、ベース側の新しいコミットが逆向きの差分として混ざり、触っていない処理を消したという指摘が出る）。

レビューのエージェント（`code-reviewer`、`security-reviewer`、`database-reviewer`、`ui-reviewer`、`falsification-qa`）は、ブランチごとに2巡まで起動できる（フック `.claude/hooks/review-budget.mjs`。最初の起動から120秒以内の起動は同じ巡）。`finding-verifier` は数えない（理由: 指摘を反証にかけるだけで、新しい指摘を出す巡ではないため）。
起動が拒否されたら、エージェントの名前を変えて呼び直す、Skill や別の経路で同じ点検をするなどで回避しない。`AskUserQuestion` でユーザーに延長を聞き、承認されたら `node .claude/hooks/review-budget.mjs extend <巡数> --reason <理由>` を実行してから呼び直す。承認されなければ、レビューを省いた旨を出力に書いて続ける。

### 7. 直す

共通の点検基準の「直す」に従う。直さない CRITICAL と HIGH は finding-verifier で検証する。修正で影響する検査を再実行する。

### 8. コミットする

`git add <paths> && git commit -m "..."` のように 1 コマンドにまとめる。
件名には、変更した対象と内容を書く（例: `fix: fill_results.py で結果の未指定と不正値を検出する`）。「レビュー指摘に対応する」のように、指摘への対応であることしか分からない件名にしない（理由: squash merge ではコミットメッセージが本文に残り、マージ後は直せない）。
PR があるときは、手順 7 の直しをすべてコミットしてからまとめて `git push` し、手順 0 の check-runs で CI が通ることを確かめる（`review` は手順 0 と同じく除く。修正は通常の push で積む。force push は使わない）。コミットごとに push しない。CI の失敗を直した後の push は、その直しをまとめてから行う（理由: push のたびに CI のジョブがすべて走り直し、前の実行の取り消しが終わるまで次の実行も始まらない。`docs/development.md` の「開発の流れ」）。

手順 7 の直しで差分が変わったら、コミットの後に手順 2 の `やらないこと` との突き合わせと判断の一覧を取り直し、出力の判断の差分をその結果にする（理由: `pr` は判断の差分から head の SHA 付きの点検の行を書くので、直しの前の結果のままだと、点検していない head を点検済みと書く）。

### 9. pr に引き継ぐ

PR 作成前なら、Skill ツールで `pr` を起動する。
pr/create.md から呼ばれた done-check なら、起動せずに pr の続きに戻る（互いに呼び合って止まらなくなるため）。
PR 作成後はここで終える。判断の差分は出力に出すだけにする。Issue の本文に足すのは、直しを push する `pr/feedback.md` の手順 3 が行う（理由: done-check は Issue を書かない）。

## 出力

- 完了条件ごとの充足状況と、手順 5 で確かめた方法（確かめられなかった項目はその旨）
- 直した指摘と、直さなかった指摘とその理由
- 点検した head: 手順 6 でレビューのエージェントに渡したときの `git rev-parse HEAD` の完全な SHA（2巡目を回したら、2巡目に渡したときのもの）。手順 7 の直しのコミットは含めない（理由: 直しはどのエージェントも見ていないので、CI の AI レビューに見せる）。`pr` が PR 本文の done-check の印に書く（`pr/create.md` の Step 3 の「done-check の印」）。手順 6 のレビューを省いたとき（上限で延長が承認されなかったときを含む）は、`点検した head: 無し — <理由>` と書く（理由: レビューしていない head を点検済みにすると、CI の AI レビューがその差分を見ない）
- 判断の差分: `やらないこと` の点検の結果（`触れていない`、`節が無い`、`触れた: <パス> — <理由>`。対話の実行で人に聞いたなら、その問いと答え）と、実装中に置いた判断で Issue と `docs/` に無いものの一覧（根拠付き。無ければ「無し」）

## 完了条件

- PR 作成後なら、手順 0 の前提が全て満たされている（スレッドの解決状態を確かめられなかったときは、その旨が出力に書かれている）
- 完了条件が全て満たされている、または満たさない理由が書かれている
- `やらないこと` との突き合わせの結果（触れていない、節が無い、触れた）と、実装中に置いた判断の一覧が、判断の差分として出力に書かれている。触れていたものは、対話の実行では人の答えが、人に聞けない実行では `触れた: <パス> — <理由>` が書かれている
- 点検した head（完全な SHA か、`無し` とその理由）が出力に書かれている
- 変更に必要な検査が通っている（再利用した結果と未実施を区別する）
- 挙動の変わる変更なら、手順 5 で実際に動かして完了条件を確かめている
- レビューエージェントの CRITICAL と HIGH が、直されているか、直さない理由が出力に書かれている。上限で起動を拒否され、延長も承認されなかったときは、レビューを省いた旨が書かれている。直さないものには `finding-verifier` の判定が付いている

## 止まる条件

- PR 作成後で、手順 0 の前提を満たさない。満たさない前提と経路を出力する
- 完了条件を満たせない。実装計画に戻る
- テストが落ちて原因が分からない
- 規約と実装方針が食い違う。どちらを取るか確認する
