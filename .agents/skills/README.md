# Codex 用スキル

各 `SKILL.md` を入口とし、必要になった原本と参照資料だけを読む。原本中の相対リンクは `.claude/skills/<名前>/` を基準に解決する。

## 共通の読み替え

- `AGENTS.md` の承認範囲と E2E 方針を優先する。E2E は CI で実行し、明示的な依頼が無ければセッションでの実行・preflight・成功記録の照合をしない。必要なテストの追加・更新は行う。
- `Skill` は `.agents/skills/<名前>/SKILL.md` を読む手順に置き換える。Claude の CLI とエージェントは起動しない。
- `AskUserQuestion` は利用できる質問ツール、無ければ会話での質問に置き換える。人の決定が必要な工程は回答を待つ。
- `Agent` と `SendMessage` は利用できる Codex の委譲・連絡機能に置き換える。Claude のモデル名・権限指定は持ち込まない。機能が無ければ自己点検と独立レビューを区別して未実施を報告する。
- Artifact の公開・更新とセッション名の変更は Claude 固有の操作として省き、未実施を報告する。別サービスへ自動で公開しない。
- コミット・push・PR/Issue 更新・コメント送信・resolve・マージは `AGENTS.md` の指示に従う。未承認ならローカルの準備と具体的な下書きまで終える。

## 配置

`increment-build`、`done-check`、`pr` とバックログ・スクラム関連は Codex 用の入口を持つ。API・DB・動きの専門スキルは既存の相対リンクで共有する。
`ai-review` は Claude を実行する CI 専用、`rename-session` は Claude のセッション操作、`impeccable` は既存の運用方針で対象外とする。`acceptance-video` はブラウザ操作と動画生成の環境依存が大きいため、今回は配置しない。

新しい Codex セッションの `/skills` または `$` の候補で確認する。ファイルの配置検証と、Codex が実際に認識したことの確認は区別する。
