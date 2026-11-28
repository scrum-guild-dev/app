#!/usr/bin/env bash
# クラウドのセッションの Bash で、PATH の先頭に /opt/node<主版>/bin を足す（SessionStart のフックから呼ぶ。docs/development.md の「クラウド環境」）。
# Claude の Bash は初期化ファイルを読まないので、セットアップスクリプト（scripts/cloud-setup.sh）が入れた Node 26 は、ここで CLAUDE_ENV_FILE に書かないと選ばれない。
# 主版は .node-version から取る。CLAUDE_ENV_FILE が無い、/opt/node<主版>/bin/node が動かない、のときは何も書かずに終了コード 0 で終える
# （手元とワークツリーの対話のセッションを変えない。終了コードが 0 以外だとフックが失敗として出る）。
# テスト用に、CLAUDE_PROJECT_DIR（.node-version の置き場所）と BANMEN_NODE_ROOT（/opt の置き換え）を読む。

root="${BANMEN_NODE_ROOT:-/opt}"
project="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)}"

[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
[ -r "${project}/.node-version" ] || exit 0

version=$(head -n 1 "${project}/.node-version" 2>/dev/null | tr -d '[:space:]')
version="${version#v}"
major="${version%%.*}"
[[ "$major" =~ ^[0-9]+$ ]] || exit 0

bin="${root}/node${major}/bin"
# 固まった node でセッションの開始を止めないよう、5 秒で切る。timeout があればそれを使い、
# 無ければ（macOS には標準で無い）bash の組み込みだけで切る（read -t で待ち、過ぎたら node を止める。bash 3.2 でも動く）
if command -v timeout >/dev/null 2>&1; then
  got=$(timeout 5 "${bin}/node" --version 2>/dev/null) || exit 0
else
  # 裏の副シェルが node を走らせ、1行目に node の PID、2行目に版を書く
  exec 3< <(exec 2>/dev/null; "${bin}/node" --version & echo "$!"; wait)
  pid=""
  got=""
  read -r -t 5 -u 3 pid || { exec 3<&-; exit 0; }
  read -r -t 5 -u 3 got
  # 終了コードで切れたかを見分けない（bash 3.2 は切れても 128 以下を返しうる）。終わっていれば kill は何もしない
  kill "$pid" 2>/dev/null
  exec 3<&-
fi
[[ "$got" == "v${major}."* ]] || exit 0

# 同じ行を二重に書かない（再開や clear でもう一度走る）
line="export PATH=\"${bin}:\$PATH\""
# 既存の最終行が改行で終わっていなければ、先に改行を足す（ほかのフックが書いた行に連結しない）
if ! grep -qxF -- "$line" "$CLAUDE_ENV_FILE" 2>/dev/null; then
  {
    if [ -s "$CLAUDE_ENV_FILE" ] && [ -n "$(tail -c 1 "$CLAUDE_ENV_FILE")" ]; then printf '\n'; fi
    printf '%s\n' "$line"
  } 2>/dev/null >> "$CLAUDE_ENV_FILE"
fi
exit 0
