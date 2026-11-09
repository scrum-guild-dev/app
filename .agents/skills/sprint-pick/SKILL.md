---
name: sprint-pick
description: 今のスプリントから着手候補を選び、作業用プロンプトを出す。
---

# sprint-pick（Codex）

最初に `AGENTS.md` と [共通の読み替え](../README.md) を読む。
[共有する手順](../../../.claude/skills/sprint-pick/SKILL.md) を読み、次の Codex 向けの扱いを優先して進める。

プロンプトは Codex 用の `$increment-build` と作業ディレクトリを示す。候補を選ぶ依頼だけで実装や別セッションの起動をしない。
