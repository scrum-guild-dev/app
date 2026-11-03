# PR レビュー履歴の集計記録

[REVIEW.md](../REVIEW.md) の初回作成の根拠。

## 対象と収集件数

- 対象: `scrum-guild-dev/app`。2026-11-04 JST に、認証済みの GitHub API から見える全 PR を収集した。
- PR は `state=all` で全ページを取得した。351 PR（merged 347、マージせず closed 4、open 0）。最新番号は #791。
- PR の作成日時は 2026-10-23 00:47:30 UTC から 2026-11-03 14:31:36 UTC まで。これはコメントの投稿期間ではない。
- インラインコメント: 1,573 件（スレッドの先頭 1,085、返信 488）。
- レビュー: 1,247 件。このうち本文が空でないものは21件で、読む場所を案内する文章だった。レビュー件数を指摘件数には換算していない。
- PR の会話コメント: 792 件。リポジトリの会話コメント1,216件から、取得済みの PR 番号に一致するものを選んだ。Issue の会話424件は除外した。

インライン、レビュー、会話はそれぞれ全ページを収集した。
返信、対応報告、案内、承認、CI の実行報告も含む収集件数であり、合計を不具合件数とは扱わない。
Bot のレビューも対象に含めた。
人のアカウントによる投稿にも AI の案内や対応報告があるため、投稿者名から人と AI の指摘の割合を推定しない。
削除済みのコメントや、認証した利用者に見えない情報は対象外。
API の取得は同一時点のトランザクションではなく、収集中の投稿変更を固定する仕組みは使っていない。

## 語句検索で見つけた候補

まず、返信ではなく、本文の先頭に `[CRITICAL]`、`[HIGH]`、`[MEDIUM]`、`[LOW]` のあるインラインコメント557件（232 PR）を抽出した。
以下は、その本文全体への語句検索で候補を探した結果。
同じカテゴリで同じ PR が何度出ても PR 数は1とする。

| 検索カテゴリ | 一致したコメント数 | 一致した PR 数 |
| --- | ---: | ---: |
| 状態の持ち越しと読み直し | 114 | 77 |
| テストとモック | 83 | 65 |
| 文書と見本への言及 | 223 | 151 |
| 上限と走査量 | 75 | 57 |
| 競合と一括書き込み | 41 | 34 |
| 認可と秘密への言及 | 54 | 43 |
| 操作性とアクセシビリティ | 91 | 68 |
| 守る仕組みと実行対象 | 19 | 15 |

この表は、確定した不具合の頻度ランキングではない。
例えば「docs/」は根拠の引用にも現れ、「同時」は UI の表示にも現れるため、カテゴリと無関係な一致を含む。
逆に、重要度の書式が違うコメントや、会話にしかない指摘はこの表に入らない。
カテゴリ間の重複があり、合計も使わない。
全コメントを意味で分類して採否や修正済みまで確定した件数は、今回の集計では出していない。

`REVIEW.md` には、候補の本文を読み、異なる3 PR の具体例を確認できた8観点をまとめた。
表と本文の観点は一対一の分類ではなく、例えばデータの境界とログの秘密はまとめて点検する。
履歴の指摘は当時のレビュー判断として参照し、現在の不具合や正しさの証明には使わない。
現在の規約と衝突する過去の提案は採用しない。

## 再収集と候補数の確認

`gh` がこのリポジトリを読み取れる環境で、空の一時ディレクトリを作って実行する。
GitHub への書き込みは行わない。
収集した本文は一時ファイルに置き、リポジトリにはコミットしない。
API が失敗したら、そのファイルから集計を続けない。

```sh
set -eu
review_dir=$(mktemp -d "${TMPDIR:-/tmp}/scrum-review.XXXXXX")
cd "$review_dir"
gh api --paginate --slurp 'repos/scrum-guild-dev/app/pulls?state=all&per_page=100' > prs.json
gh api --paginate --slurp 'repos/scrum-guild-dev/app/pulls/comments?per_page=100' > inline.json
gh api --paginate --slurp 'repos/scrum-guild-dev/app/issues/comments?per_page=100' > conversations.json
```

`--slurp` の結果はページごとの配列になる。
次の Python を同じディレクトリで実行すると、全 PR のレビュー取得、会話の絞り込み、上の候補数の再計算ができる。
本文からの文字列をシェルの命令として実行しない。
数値は再収集した時点の履歴によって変わる。

```python
import json
import re
import subprocess
from pathlib import Path


def pages(name):
    return [item for page in json.loads(Path(name).read_text()) for item in page]


prs = pages('prs.json')
numbers = {pr['number'] for pr in prs}
reviews = []
for number in sorted(numbers):
    result = subprocess.run(
        ['gh', 'api', '--paginate', '--slurp',
         f'repos/scrum-guild-dev/app/pulls/{number}/reviews?per_page=100'],
        check=True, capture_output=True, text=True,
    )
    reviews.append({'pr': number, 'reviews': sum(json.loads(result.stdout), [])})
Path('reviews.json').write_text(json.dumps(reviews, ensure_ascii=False))
conversations = [c for c in pages('conversations.json')
                 if int(c['issue_url'].rsplit('/', 1)[-1]) in numbers]
inline = pages('inline.json')
findings = [c for c in inline if not c.get('in_reply_to_id') and re.match(
    r'^\s*(?:\*\*)?\[(?:CRITICAL|HIGH|MEDIUM|LOW)\]', c['body'])]
patterns = {
    'state': '古い|残ったまま|残りま|残る|切り替え|切り替わ|読み直|応答.*(逆|遅)|競合',
    'tests': 'テスト.*(通|失敗|拾|確かめ|見て|検|待)|expect\\(|モック|固定日付',
    'docs': '文書|docs/|カタログ|見本|コメント.*(説明|矛盾|合|成り立)',
    'limits': '上限|LIMIT|全件|走査|N\\+1|無制限|読み込.*全',
    'atomic': 'batch\\(|同時|トランザクション|二重|原子的|書き込.*(間|後)|競合',
    'auth': '別の組織|組織.*絞|権限|認可|404|秘密|トークン',
    'ui': 'フォーカス|スクリーンリーダ|aria-|読み上げ|44px|760px|狭い|折り返|はみ出',
    'guards': 'fail.open|すり抜|迂回|シェル|コマンド置換|前方一致|pipefail|head.*SHA|base.*SHA',
}
for category, pattern in patterns.items():
    hits = [c for c in findings if re.search(pattern, c['body'], re.I)]
    print(category, len(hits), len({c['pull_request_url'] for c in hits}))
print('PRs', len(prs), 'inline', len(inline), 'conversations', len(conversations),
      'reviews', sum(len(pr['reviews']) for pr in reviews))
```

件数の再計算後は、検索に一致した本文と返信を読んで、再発する条件を確かめる。
同じ問題の再レビューを別の発生として数えず、誤検知の反証や対応結果も読む。
新しい項目を採るときは、異なる PR の根拠を `REVIEW.md` に添える。

## 今回の範囲

作成したのは、人と AI が参照する確認項目と、この集計記録。
既存のレビュー定義、チェックリスト、CI、API、画面の振る舞いは変更していない。
定期収集、AI による自動更新、GitHub への投稿は別の変更として扱う。
