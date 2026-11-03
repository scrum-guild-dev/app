スクラムギルド ロゴ素材 — オレンジ案

favicon/
  favicon.ico             16 / 32 / 48 px を収録
  favicon-16.png ～ 64.png 透過PNG

app/
  icon-white-1024.png     スマホアプリ用・白背景・角丸加工なし
  icon-white-512.png      PWA用
  icon-white-192.png      PWA用
  icon-white-180.png      Apple touch icon用
  icon-transparent-1024.png 文字なし透過マーク
  icon-maskable-512.png   PWA maskable用（中央に余白を確保）

header/
  logo-transparent-1200.png 1200 × 400 px 透過
  logo-transparent-600.png   600 × 200 px 透過
  logo-white-1200.png / logo-white-600.png 白背景

master/
  logo-horizontal.png 横組みの元画像・透過PNG
  symbol.png          マークのみの元画像・透過PNG

主な指定色：オレンジ #F58220 / チャコール #303740
生成画像から書き出したラスター画像です。画素の色には微差があります。
SVGなどのベクターデータは含みません。

Webでの使用例（素材フォルダを /brand/ に配置した場合）：
<link rel="icon" href="/brand/favicon/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/app/icon-white-180.png">
<img src="/brand/header/logo-transparent-1200.png" alt="スクラムギルド" width="240" height="80">

app/site.webmanifest を使う場合は配置先に合わせて start_url を設定してください。
