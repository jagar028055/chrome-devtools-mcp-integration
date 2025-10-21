# PDF取得アプローチ調査レポート

2025-10-10 時点での NomuraNow 本文PDF自動取得に関する試行内容と判明した課題をまとめる。

## 実装・検証の概要

- `scripts/fulltext/extractors.js` にて `--enable-cdp-fallback` 指定時は HTTP 経由の直接ダウンロードをスキップし、Playwright CDP フォールバックを最優先で実行するよう変更。
- `scripts/fulltext/chromeFallback.js` では `#pdf-download-btn` など NomuraNow 固有のセレクタを追加し、CDP 経由でのダウンロード／インラインPDF捕捉を実装。ログ (`logs/devtools/<date>/<entryId>.json`) に操作詳細を残す。
- Google Drive へのアップロードフロー (`scripts/fulltext/drive.js`) は Buffer/Readable 対応済み。`config/pdfSites.json` でセレクタ優先順位を調整済み。

## 実行した主なテスト

| 日時 | コマンド | 補足 |
| --- | --- | --- |
| 2025-10-10 | `npm test` | `testConversion.js`, `testFulltextPlain.js`, `testDriveUpload.js`, `testCdpFallback.js` すべて成功。
| 2025-10-10 | `node scripts/fetchFulltext.js --date 2025-10-07 --category "為替モーニングコメント" --storage-state storage_state.json --max-entries 1 --drive-upload --drive-folder-id ... --enable-cdp-fallback --debug` | CDP フォールバック発動。`tmp/fulltext-cdp/2025-10-07/1264520.pdf` 生成。ただし内容は HTML。処理は本文抽出失敗で終了。
| 2025-10-10 | 同上 (`--rate-wait 1000` で再実行) | 挙動に変化なし。`1264520.pdf` は HTML。Drive アップロード未実施。

## 判明した問題点

1. **社内向けゲートウェイへのリダイレクト**  
   NomuraNow の `download?format=pdf` 系 URL は最終的に `http://prod-eu-vip-grp-api...` へ 302 リダイレクトする。外部ネットワークでは DNS 解決ができず `ENOTFOUND` で必ず失敗する。HTTP フォールバック経路はこの段階でタイムアウト。

2. **CDPフォールバックが取得するのはビューアHTML**  
   `#pdf-download-btn` をクリックすると `https://researchcdn.nomuranow.com/…/1264520.file?...` が開くが、これは PDF ビューア (HTML) で、本文ページを画像として埋め込んでいるだけ。`tmp/fulltext-cdp/2025-10-07/1264520.pdf` の先頭は `<html>` で始まっており、`pdfParse` では「Invalid PDF structure」と判定される。

3. **本文抽出ロジックとの整合が取れない**  
   CDP で取得したファイルが HTML のため、`fetchFullText` 内の `pdfParse` → `isDisclosureOnly` 判定で本文が空扱いとなり、最大リトライ回数まで同じページを再試行し続ける。Drive アップロード等の後続処理に進めない。

## 技術的課題 / 今後の検討ポイント

- 社内ネットワーク (VPN 等) を利用するか、社内プロキシを `.env` から Playwright/REST に渡して `prod-eu-vip-grp-api` へ到達可能な環境で実行する。これが実現できれば `download?format=pdf` から実ファイルが取得できる。
- もしくはビューア HTML から本物の PDF URL を抽出する別経路を実装する。例: 
  - ビューア内で使われている画像／XHR ではなく、`publication/1264520.file` の実体にアクセスできる API をリバースエンジニアリングする。
  - もしくはビューアがロードする Canvas/画像をダウンロードして再PDF化する (品質低下・工数大)。
- `pdfParse` に通さず Drive へアップロードするだけなら一時ファイルを HTML のまま持てるが、本文テキスト抽出／検索性を維持する要件とは相容れない。本文テキストを取得できる代替手段 (例えば HTML からテキスト抽出) を検討する必要がある。
- 処理時間短縮のため、`config/pdfSites.json` から社内ドメイン向けURLを除外し CDP フォールバックのみを走らせる設定は完了済み。ただし現状は HTML 保存止まりのため、本体 PDF 取得ロジックの実装が必須。

## まとめ

- CDP フォールバック自体は機能しているが、最終的に取得できているのは HTML ビューアであり、本体 PDF ではない。
- 外部ネットワーク環境では NomuraNow の内部API (`prod-eu-vip-grp-api...`) に接続できず、直接ダウンロード方式は不可。
- 今後は「社内ネットワーク経由での実行」または「ビューアから実ファイルを抽出する追加実装」のいずれかを検討する必要がある。

## HTMLビューアからの本文抽出検討 (2025-10-11)

### 現状整理
- `tmp/fulltext-cdp/2025-10-07/1264520.pdf` は先頭が `<html>` のビューアHTMLであり、`div.content-grid > main.center > article.front-page` 以下に本文テキストおよび脚注が埋め込まれている。
- ビューアは `.collapsible` などのクラスで折り畳み制御されており、`innerText` 取得時には非表示要素が除外される。Playwright 側で展開しないと本文が短く評価され `isDisclosureOnly` によるフィルタで HTML 結果が破棄され、CDP フォールバックへ遷移している。
- `downloadPdfViaCDP` はファイル拡張子 `.pdf` のままHTMLを保存するため、`pdf-parse` で `Invalid PDF structure` が発生し、本文テキストが最終成果物に残らない。
- `scripts/fulltext/output.js` の `--write-plain` オプションを有効にすると `reports/fulltext/plain/<entryId>.txt` を出力できる仕組みは既に存在するが、HTML経由でテキストが抽出できたケースが想定されていない。

### 実現方針（案）
1. **HTML抽出の安定化**: `scripts/fulltext/extractors.js` 内でビューア用セレクタ (`main.center`, `div.content-grid`, `article.front-page` 等) を追加し、`page.evaluate` で `.collapsible` に `classList.add('expanded')` と `style.display = 'block'` を付与した上で `innerText` を再取得する。`innerText` が閾値未満の場合は `textContent` や JSDOM ベースのフォールバックを追加する。
2. **CDPフォールバックのHTML判定とテキスト化**: `downloadPdfViaCDP` の戻り値処理で「Content-Type に pdf が含まれない」「バッファ先頭が `<`」等を検出し、HTMLとして保存。新規ユーティリティ (例: `scripts/fulltext/htmlToText.js`) を用意し、`jsdom` もしくはヘッドレス `playwright` で DOM を再評価して本文テキストを抽出して `fetchFullText` に返す。必要に応じて HTML 原本を `tmp/fulltext-cdp/<date>/<entryId>.html` として残す。
3. **成果物出力**: HTMLから得たテキスト結果でも `result.buffer` 無しで処理を完結できるようにし、`--write-plain` 利用時に `.txt` が確実に生成されることを確認。任意で HTML テキストを PDF に再変換する場合は別タスクとして切り出す。

### タスクリスト
- [x] `extractHtml` 改修: ビューアセレクタ追加、折り畳み展開、`textContent` / JSDOM フォールバックを実装し、`isDisclosureOnly` 誤判定を回避する。
- [x] `chromeFallback`/`extractors` 連携改修: CDPフォールバック結果がHTMLだった場合に静的テキスト抽出へ切り替える処理を追加し、`pdf-parse` エラーを握りつぶさない。
- [x] HTML→テキスト変換ユーティリティ実装: `jsdom` 等を導入し、主要セクション (`article.front-page`, `.theme-container`, `.disclosure`) の順序を保ったテキスト整形ロジックと単体テストを整備する。
- [x] `--write-plain` 動作確認およびドキュメント更新: HTML経由で生成した `.txt` の配置パスと利用手順を README もしくは社内 wiki に追記する。
- [x] 回 regresstion テスト追加: `scripts/testFulltextPlain.js` などにビューアHTMLのフィクスチャを組み込み、HTML挙動が退行しないことを自動化する。

### HTMLフォールバック実装進捗 (2025-10-20)
- `downloadPdfViaCDP` がレスポンス先頭を検査し、PDF/HTML/その他を判別するよう改修。HTMLの場合は `.html` として保存し、ログに抽出タイプを記録。
- `extractors.tryPdfFallback` が `type: 'html'` を受け取り `htmlToText` で本文抽出・メタ情報（タイトル/発行日/著者）を付与。`meta.htmlMeta` を下流に渡す。
- `htmlToText` が DOM から折り畳み要素を展開し、JSDOM 経由で本文とメタ情報を整形して返却するよう拡張。
- `testCdpFallback.js`, `testHtmlToText.js` を更新し、HTMLフォールバック経路の`type`判定とメタ抽出を検証。`npm test` では `testConversion.js` / `testFulltextPlain.js` / `testDriveUpload.js` / `testCdpFallback.js` / `testHtmlToText.js` が全て成功。
- `writeRegionOutputs` / `writeCategoryOutputs` を調整し、`--write-plain` 有効時に `fulltext/plain/*.txt` を安定生成することを `testFulltextPlain.js` で確認済み。
- HTMLビューアのフィクスチャ（`fixtures/html_viewer_sample.html`）を追加し、`testFulltextPlain.js` で折り畳み要素を含む本文/脚注が `.txt` に出力されることを検証。
- 2025-10-20 追記: `collectPdfCandidates` に `publication/<entryId>.file` を追加し、`extractPdf` による直接ダウンロードを優先実行。HTML抜粋が成功した場合も `.file` 取得に成功すれば `buffer` として添付し、`tmp/fulltext-pdf/<date>/<entryId>-<hash>.pdf` が生成されることを `fetchFulltext.js --debug --write-plain` の実行で確認済み（Driveアップロードも成功）。
- 2025-10-20 追記: Google Drive 上の保存階層を `ResearchReports/<date>/<provider>/pdf` に統一。証券会社は URL ドメインからスラッグ化して生成し、既存の `NomuraReports` フォルダ構造を自動的に移行（`FULLTEXT_DRIVE_ROOT_NAME` を新設）。必要に応じて `FULLTEXT_DRIVE_FLAT=1` でルート直下にフラット保存する構成も選択可能。
