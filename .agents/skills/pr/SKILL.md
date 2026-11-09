---
name: pr
description: 自分の PR の準備・作成と CI・レビュー対応を進める。
---

# pr（Codex）

最初に `AGENTS.md` と [共通の読み替え](../README.md) を読む。
[共有する手順](../../../.claude/skills/pr/SKILL.md) を読み、次の Codex 向けの扱いを優先して進める。

対象 PR の状態から原本の `create.md`、`feedback.md`、`merge.md` の必要な工程だけを読む。`done-check` は Codex 用を使う。E2E の事前実行・`--verify`・終了コード 3 の取得を PR 作成条件にしない。CI の `e2e`、`e2e-dev`、`e2e-repeat` の結果を確認し、未実行・未確認は区別して報告する。
