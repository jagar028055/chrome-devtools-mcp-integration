# PDF自動保存・Googleドライブ連携 実装計画

## 目的
- NomuraNowの調査レポート本文がHTMLでは取得不可であるため、PDF版を自動ダウンロードして保管する。
- 保存したPDFをGoogleドライブ上の専用フォルダにアップロードし、参照リンクを既存の本文JSONに記録する。
- プロセス全体を既存の `fetchFulltext` フローに統合し、カテゴリ別取得に対応する。

## スコープ
- 対象レポート: `fetchFulltext` で検出した全URL（カテゴリ/日付フィルタ適用済み）。
- 保存先: ローカル一時ディレクトリ `tmp/fulltext-pdf/<date>/` と Google Drive フォルダID `1593sqSQhNgKE7m0noKVdSbJC_XDHtdQ3`（ルート直下に `YYYY-MM-DD_<レポートタイトル>_<要約抜粋>.pdf` 形式で保存）。
- 出力: `reports/<date>/fulltext/<category>.json` に `pdfPath`（ローカル相対パス）と `driveFileId`（Google Drive ID）を追記。失敗記録は `failed.csv` に理由・HTTPステータスなどを保持。

## 前提・制約
- NomuraNow へのアクセスは既存の `storage_state.json` を利用する。
- サンドボックス環境ではブラウザ起動・外部ネットワークへのアクセス権限が必要。CI/CD 導入時は許可設定を確認する。
- Google Drive へのアップロードは社内規定の確認が必須。禁止されている場合は社内ストレージに切り替える。
- Google API の認証方法（OAuth2 / サービスアカウント）を事前に決定し、資格情報を安全に管理する。
- PDFは機密情報の可能性が高いため、保存ディレクトリとDriveフォルダのアクセス制御・暗号化を考慮する。
- `FULLTEXT_DRIVE_ROOT_NAME` でルートフォルダ名（既定: `ResearchReports`）を指定し、現在は `FULLTEXT_DRIVE_FLAT=1` を既定値としてフラット保存を運用する。

## 全体フロー
1. Playwrightでレポートページを開き、PDFダウンロード候補URLを列挙。
2. 候補ごとにダウンロード試行し、本文が含まれるPDFを特定。
3. 判定に成功したPDFをローカル一時パスへ保存。
4. Google Drive API を用いてPDFをアップロードし、ファイルID・共有設定を取得。
5. JSON出力に本文テキスト（既存処理）・PDFメタ情報を格納。
6. アップロード失敗・本文抽出失敗は `failed.csv` へ追記し、リトライ回数を制御。
7. Chrome DevTools（CDP）経由のブラウザ自動操作でPDFビューアを開き、UI クリック経路からダウンロードする（フォールバック）。

## 実装タスク
### 1. 環境整備
- [x] Google Cloud Console で Drive API を有効化し、サービスアカウント or OAuth クライアントを発行（既存設定確認済み）。
- [x] 資格情報(JSON)を安全な場所へ配置し、`GOOGLE_APPLICATION_CREDENTIALS` などの環境変数で参照（.env設定済み）。
- [x] `package.json` に `googleapis` を追加し、`npm install` を実施。
- [x] Drive/GCP 設定値を `.env` に集約し、`scripts/config/env.js` でロード。
  - `.env.example` をコピーして本番用の値を設定する。
  - OAuthトークン取得は `npm run auth` で実行し、`secure/credentials/token.json` に保存。
  - プロキシ環境では `.env` の `FULLTEXT_PROXY_SERVER` などを設定する。
- [x] Playwright 実行環境で外部へのHTTPアクセスが許可されているか確認（動作確認済み）。
- [x] Chrome をリモートデバッグ有効化（`--remote-debugging-port=9222`）で起動するためのガイドを整備（README.mdに追加）。
- [x] `.env` に Chrome DevTools設定を追加（CHROME_DEVTOOLS_PORT等、.env.exampleに記載済み）。

### 2. PDFダウンロード機構
- [x] `fetchFulltext` 内でPDF判定を行い、本文抽出用とは別にバイナリ取得メソッドを用意。
- [x] PDFバッファを `tmp/fulltext-pdf/<date>/<entryId>.pdf` に保存するヘルパーを追加。
- [x] 既存 `tryPdfFallback` ロジックをリファクタリングし、ダウンロードとテキスト抽出を分離。
- [x] PDF保存後にテキスト抽出を実行し、本文を `items[].text` に格納。
- [x] 保存／抽出の成否をログと `failed.csv` に反映。
- [x] HTML→PDF自動取得失敗時に Chrome DevTools 経由でページ操作するフォールバックロジックを追加。
- [x] `page.waitForEvent('download')` を通じたファイル監視と保存フローを実装。
- [x] フォールバック対象サイトごとの DOM セレクタや操作手順を設定化（`config/pdfSites.json` 等）。

### 3. Google Drive 連携
- [x] Drive API クライアント（`googleapis`）を初期化するユーティリティ (`scripts/fulltext/drive.js` 等) を作成。
- [x] アップロード用関数にフォルダID（またはパス）を渡し、ファイルID・URLを取得。
- [x] アップロード結果を `items[].driveFileId` および `driveWebViewLink` などとして保存。
- [x] エラー時はリトライ戦略（指数バックオフ）と失敗記録を実装。
- [x] Chrome DevTools フォールバックで得たPDFも Drive へ同一ロジックでアップロードできるよう統合。

### 4. 取得パイプライン更新
- [x] `fetchFulltext` の結果オブジェクトに `pdfPath` / `driveFileId` / `driveLink` を追加。
- [x] `writeCategoryOutputs` を更新し、新フィールドをシリアライズ。
- [x] `overseas_reports.csv` にPDFパス/Driveリンク列を追加。
- [x] 既存 `--write-plain` オプションと整合性を確認 (`.env` 読み込み対応済み)。
- [x] CDP接続可否を判定し、PDF取得戦略（直接DL vs DevTools）を切り替える仕組みを導入。
- [x] フォールバック有無を結果JSONに `pdfFallback` などのメタ情報で記録（`meta.via: 'cdp-fallback'`）。

### 5. ログ・モニタリング
- [x] デバッグログでPDF候補URL、採用したURL、アップロード結果を出力。
- [x] 成功／失敗件数・Driveアップロード数をサマリ出力。
- [x] 想定外のエラー（HTTP 403/404、認証エラー等）を検出して適切にメッセージ化。
- [x] DevToolsフォールバック発生時の操作ログ（クリック対象、ネットワークレスポンス）を保存。
- [x] `logs/devtools/<date>/<entryId>.json` にCDP操作の詳細ログを保存。

### 6. テスト・検証
- [x] サンプルURLでPDF保存→Driveアップロード→JSON更新の一連動作を確認。
- [x] ネットワーク障害やDriveエラーをモック化／リトライ検証。
  - 自動テスト: `npm test` に `scripts/testFulltextPlain.js` と `scripts/testDriveUpload.js` を組み込み済み。
- [ ] 実日付（例: 2025-10-04）のカテゴリで少数件（`--max-entries 3`）を実行し、Drive上でファイル確認。
- [ ] セキュリティレビュー（資格情報管理・アクセス権・ログ出力）を実施。
- [ ] リモートデバッグ接続（CDP）経由のフォールバックをローカル実ブラウザでE2E検証。
- [ ] MCP経由の操作（chrome-devtools-mcp）で同手順を再現できるか確認。

### 7. フォールバック実装指針（Chrome DevTools）✅ 実装完了
- [x] Chromeを `--remote-debugging-port=9222 --user-data-dir=<path>` で起動し、既存ログイン状態を利用（README.mdにガイド記載）。
- [x] `scripts/fulltext/chromeFallback.js` で以下を提供:
  1. CDP接続 (`chromium.connectOverCDP`) による `browserContext` 再利用
  2. 対象URLを新規タブで開き、PDFリンクの DOM 操作（`config/pdfSites.json`でセレクタ設定）
  3. `page.waitForEvent('download')` からファイルを一時保存 (`tmp/fulltext-cdp/<date>`)
  4. 正常終了後は PDF パスを `fetchFulltext` に返却
- [x] `isCDPAvailable()` でCDP接続可否を自動判定し、利用可能時のみフォールバック実行。
- [x] DevTools コンソールログとネットワークレスポンスを `logs/devtools/<date>/<entryId>.json` に保存。
- [x] `--enable-cdp-fallback` / `--cdp` オプションで機能を有効化。

## 工数目安
| フェーズ | 概算時間 |
| --- | --- |
| 1. 環境整備 | 0.5〜1日 |
| 2. PDFダウンロード機構改修 | 1〜1.5日 |
| 3. Google Drive 連携 | 1〜1.5日 |
| 4. パイプライン更新 | 0.5日 |
| 5. ログ・モニタリング整備 | 0.5日 |
| 6. テスト・検証 | 1日 |

## リスクと対策
- **Driveアップロード禁止**: 社内規定違反の恐れ → 事前承認を取得し、NGなら別ストレージに切り替える。
- **認証情報漏洩**: 資格情報ファイルの保管とアクセス制御を厳格にし、`.gitignore` に登録。
- **ネットワーク制限**: サンドボックスや社内ネットワークでDrive APIが遮断される可能性 → VPC経由の許可やプロキシ設定を検討。
- **PDF品質／レイアウト**: テキスト抽出が困難な場合はOCRや別ツール導入を検討。
- **処理時間**: PDFダウンロード・アップロードで時間が増加 → 進捗ログと `--max-entries` などのオプションで調整。

## 次のステップ
1. Google Drive 利用可否の確認とAPI認証方式の決定。
2. サンプルレポートでPDFダウンロード→Driveアップロードの手動検証。
3. `scripts/fulltext` 配下にDriveクライアントを実装し、`fetchFulltext` フローへ統合。
4. 実運用向けのリトライ・ログ整備と最終テストを実施。

## 追加タスク（2025-10-09 コードレビュー反映）✅ 完了
- [x] `scripts/fulltext/extractors.js` の `detectResourceType` で HEAD が 4xx を返した際にも GET 判定へ進むようロジックを調整し、PDF/HTML 判定精度を改善する。
- [x] `fetchFullText` が HTML 抽出に失敗した場合でも `tryPdfFallback`（通常+CDP）を必ず実行するよう例外ハンドリングを再構成し、PDF経路の取りこぼしを解消する。
- [x] `scripts/fulltext/chromeFallback.js` の `connectViaCDP` クリーンアップ処理から `browser.close()` を排除し、既存ブラウザプロセスを終了させない `disconnect` 実装に改める。
- [x] CDP フォールバック時に複数セレクタの順次クリックやタブ遷移を扱えるリトライ（クリック→ダウンロード監視→未検出時に次セレクタ）を追加し、NomuraNow の UI 変化に追随させる。
- [x] CDP フォールバックと PDF 取得フローを対象にした自動テスト（モックまたはローカルサーバー）を整備し、`npm test` に組み込む。
