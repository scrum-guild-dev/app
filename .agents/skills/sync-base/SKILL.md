---
name: sync-base
description: 最新のベースを merge で取り込み、競合を解消・検証する。
---

# sync-base（Codex）

最初に `AGENTS.md` と [共通の読み替え](../README.md) を読む。
[共有する手順](../../../.claude/skills/sync-base/SKILL.md) を読み、次の Codex 向けの扱いを優先して進める。

merge コミットと push はそれぞれ依頼・承認の範囲で行う。push が未承認なら取り込みと検証までで返す。sandbox の外での実行を前提にせず、必要なときだけ現在の環境の承認手順を使う。
