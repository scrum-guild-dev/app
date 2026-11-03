---
name: pr
description: 自分の PR を作成し、CI・レビュー指摘への対応と最終報告まで進める。既存 PR の対応再開にも使う。他人の PR のレビューや概要だけの検証は対象外。
---

# PR の作成と対応

差分から PR を作り、CI と AI レビューの対応、返信・resolve、最終レポートまで進める。既存 PR では作成手順を読み直さず、状態から再開する。
Claude と Codex はそれぞれ単独で使い、別製品の CLI やエージェントを起動しない。

## 製品ごとの扱い

- Claude は CLAUDE.md の進行・承認条件と、参照先の手順を使う。
- Codex は AGENTS.md の承認範囲を優先する。コミット・push・PR/Issue 更新・コメント・resolve・マージは対象と操作を承認された場合だけ行う。未承認なら安全なローカル準備と下書きを終え、具体的な操作を示す。
- 参照先の Skill、AskUserQuestion、SendMessage、Artifact は Claude の道具名。Codex は現在のセッションの道具に読み替え、別製品は起動しない。done-check は各製品の入口を使い、pr から呼んだ場合は点検後に呼び出した工程へ戻す。pr を重ねて起動しない。rename-session と daily-scrum の Claude 固有操作は、Codex では実行せず未実施を報告する。

## 状態から進める

対象 PR の番号・URL、または現在の作業ブランチを使う。ブランチ・作業ディレクトリ・既存差分を確認する。
PR 番号が無ければ、そのブランチの開いた PR を読み取りで探す。

```bash
gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0] | {number, url: .html_url, state, draft, base: .base.ref, head: .head.sha}'
```

- PR が無い: [create.md](create.md) で点検・本文準備・作成を行い、作成後は feedback.md に進む。
- 開いた PR がある: [feedback.md](feedback.md) で CI・指摘・返信・解決状態を確認する。タイトルやメタデータの更新を依頼された場合だけ create.md の更新モードを使う。概要だけの検証は pr-description-review に従う。
- マージ済みの PR、またはレビュー対応を終えてマージ判断へ進む: [merge.md](merge.md) で承認条件と後片付けを確認する。未マージで閉じた PR は勝手に再開せず、状態を報告する。

Issue 更新が必要なときだけ [issue-update.md](issue-update.md)、gh が使えないときだけ [github-mcp.md](github-mcp.md)、スタック PR のときだけ [stack.md](stack.md) を読む。参照先を一括で読まない。
既存 PR と互換性を保つため、コメント内の `pr-create:guide` と `pr-create:draft-first` の識別子は改名しない。
各工程で取得した状態・検査記録を引き継ぎ、入力が同じ検査を工程の切り替えだけで繰り返さない。

## 完了と報告

指摘は方針・結果を全件返信し、対応済みのインラインは resolve を確認する。修正と検査・必要なベース取り込みを終えてからコミットをまとめて1回で push する。
CI・AI レビュー対応後は docs/development.md の「CI・AI レビュー対応後のレポート」の6行形式で報告する。未検証・未解決・承認待ちは残件に明示し、最新 head の条件を確かめたときだけ「マージ可能」と書く。報告はマージ操作への承認を増やさない。
