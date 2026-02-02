ALMANI（アルマニ）

動画から作業手順を分析し、LAP・秒数・標準作業組み合わせ表まで一貫して作成できるデスクトップアプリ
ALMANI は、現場動画をもとに
  作業を時系列で分析（LAP）
  旧Excel資産と完全互換で保存
  標準作業組み合わせ表を自動生成
までを 1アプリで完結 させるためのツールです。

特徴

🎬 動画分析モード / 再生モードを厳密に分離
⏱ LAP管理（絶対秒・差分秒・相対Time）
🧾 旧Excel版 ALMANI CSV 完全互換
📊 標準作業組み合わせ表（SVGチャート自動描画）
🔁 右クリックで途中から分析やり直し
🔊 音量・再生速度制御
🖥 pywebview によるデスクトップアプリ

画面構成

メイン画面
  左：動画プレーヤー（字幕・LAP・再生制御）
  右：作業手順書（LAP一覧・クリックジャンプ）
標準作業組み合わせ表
  手作業 / 自動 / 歩行 を統合表示
  秒軸グリッド＋takt線対応
  SVGオーバーレイ描画

フォルダ構成

almani/
├─ app.py                # Flask + pywebview 本体
├─ pyvenv.cfg
├─ Include/
├─ Lib/
├─ Scripts/
└─ web/
   ├─ index.html         # メインUI
   ├─ styles.css
   ├─ app.js             # メインロジック（LAP/分析/保存）
   ├─ std-work.html      # 標準作業組み合わせ表
   ├─ std-work.css
   └─ std-works.js       # 組み合わせ表描画ロジック

動作要件

Python 3.9+
Windows（tkinter / pywebview 前提）
対応動画形式
  .mp4 / .m4v / .mov
ffmpeg 不要（ブラウザデコード依存）

起動方法

python app.py
起動するとローカル Flask サーバが自動起動し、
デスクトップアプリとして全画面表示されます。

基本操作

1. 新規プロジェクト
  右メニュー → 新規プロジェクト
  動画を選択（自動再生なし）
2. 動画分析
  右メニュー → 動画分析モード
  再生しながら LAP を追加
  作業名 / 区分 / 急所を編集
3. 保存 / 読込
  旧Excel互換 CSV で保存
  既存CSVの再読込可（ズレなし）
4. 標準作業組み合わせ表
  右メニュー → 標準作業組み合わせ表を作成
  自動で別画面表示（SVG描画）

CSV互換仕様（概要）

Time列
  Excel時刻シリアル（1日=1.0）
秒列
  差分秒（次工程までの所要時間）
読込時は 差分秒を累積して開始時刻を復元
既存の Excel ALMANI 資産を そのまま利用可能 です。

技術構成

Python
  Flask（ローカルAPI）
  pywebview（デスクトップ化）
  tkinter（ファイルダイアログ）
Frontend
  Vanilla JS
  SVG（標準作業チャート）
  CSS Grid / Variables
