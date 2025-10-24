# 複数証券会社レポート取得・保存計画（初版 2025-10-21）

## 目的
- Nomura（既存）に加え、SMBC日興証券、大和証券、みずほ証券、三菱UFJモルガン・スタンレー証券のレポートを自動取得し、PDF・テキスト・メタ情報を統合的に管理する。
- 出力フォルダ構成を共通化し、AI読み込みや検索性を高める。
- 将来の対象拡張を見据えて、取得フローと設定ファイルをモジュール化する。

## 想定ワークフロー概要
1. 各社のレポート一覧を取得（スクレイピングまたは既存APIがあれば利用）。
2. 一覧データを標準化し、日付・カテゴリ・タイトル・URLを `reports/<date>/sources/<provider>.json` に保存。
3. `fetchFulltext`（または派生スクリプト）で本文/PDF を取得。
4. PDF を Drive に保存（`--drive-flat` で日付付きファイル名に統一）。
5. メタ情報を `reports/.meta/<date>/fulltext/<provider>_<category>.json` に集約。

## ディレクトリ構成案（ローカル／Drive）
### ローカル（既存に追加）
```
reports/
  2025-10-14/
    sources/
      nomura.json
      smbc_nikko.json
      daiwa.json
      mizuhosc.json
      mufg_mss.json
    overseas_reports.json   # 既存形式（必要に応じて provider 別に変換）
    fulltext/               # 生成された結果（既存）
tmp/
  providers/
    smbc/...
    daiwa/...
```

### Google Drive
- `--drive-flat` を基本方針とし、指定フォルダID直下に `YYYY-MM-DD_<provider>_<title>.pdf` を保存。
- テキスト・メタJSONも必要なら同フォルダへアップロード（後続タスクで検討）。

## 実装タスク一覧

### 0. 共通基盤整備
- [x] `scripts/providers/` ディレクトリを作成し、各社ごとの取得スクリプトを分離。
- [x] `config/providers.json` を追加し、各社の設定（ベースURL、ログイン方法、カテゴリの正規化ルール）を定義。
- [x] 取得結果を標準フォーマットに変換するヘルパー（ID、タイトル、カテゴリ、日付、URL、providerSlug を揃える）。

### 1. SMBC日興証券
- [x] ログイン状態（storage_state もしくは OAuth）を確認。
- [x] レポート一覧ページの構造調査（HTML/CMS/API）。
- [x] 主要カテゴリ（例: 為替、株式、マクロ）を抽出するセレクタ・エンドポイントを特定。
- [x] `scripts/providers/smbc.js` を実装し、日付フィルタとカテゴリ分けを行い `reports/<date>/sources/smbc_nikko.json` を出力。
- [x] PDF 取得方法（`?format=pdf` / `.pdf` / ビューアHTML）を確認し、直接ダウンロードURLから本文取得を行う。
- [x] `deriveProviderSlug` に `smbc-nikko` を登録（既存 `PROVIDER_RULES` へ）。

### 2. 大和証券
- [x] 会員ページの認証方式を確認（ID/PWのみ、ワンタイムパス不要）。
- [ ] レポート一覧のカテゴリ構成を調査し、スクレイピング／APIの可否を確認（現状はキーワード検索により暫定対応）。
- [x] `scripts/providers/daiwa.js` を実装し、`reports/<date>/sources/daiwa.json` を生成。
- [ ] PDF ダウンロードパターンを `collectPdfCandidates` に追加（例: `_download.pdf` など）。
- [ ] 追加の CAPTCHA やファイル名規則があれば `buildDriveFileName` に反映。

### 3. みずほ証券（余裕があれば）
- [ ] Nomura 同様に `.file` や専用ビューアの有無を調査。
- [ ] `scripts/providers/mizuho.js` を実装し、`reports/<date>/sources/mizuhosc.json` を生成。
- [ ] 必要に応じてプロキシ設定やユーザーエージェントを調整。
- [ ] PDF ダウンロード時のリダイレクトや JS 内 token を解析。

### 4. 三菱UFJモルガン・スタンレー証券（余裕があれば）
- [ ] 会員制サイトのログインプロセスを確認。
- [ ] レポート一覧（カテゴリ／タグ）を抽出して JSON 化。
- [ ] `scripts/providers/mufgsm.js` を実装し、`reports/<date>/sources/mufgsm.json` を生成。
- [ ] PDF の保存フローを検証し、`collectPdfCandidates` にパターンを追加。

 ### 5. 差分管理・統合
- [x] `collectReports.js` を拡張し、各プロバイダスクリプトを順番に呼び出すオプション `--provider` を追加（デフォルト: 全社）。
- [x] `loadSources` をプロバイダ別 JSON に対応させ、`provider` フィールドを保持。
- [x] `fetchFulltext` の `driveFileName` を `YYYY-MM-DD_<provider>_<title>.pdf` に統一。
- [ ] 各社で認証状態が切れた場合のリトライ・エラーログを整備。
- [ ] `docs/` に各社の手順（ログイン方法、既知の制限、テストURL）を追記。

### 6. テスト整備
- [ ] 各プロバイダのモックデータ（一覧JSON）を `fixtures/providers/<provider>/` に作成。
- [ ] `scripts/testProviders.js` を追加し、標準フォーマットへ変換できることを検証。
- [ ] `testDriveUpload.js` に新しいプロパティ（`provider`）が反映されるか確認。
- [ ] E2E テスト: 実際のアカウントで 1 日分のレポートを取得し、Drive にアップロードされること・`reports/.meta/<date>/fulltext/*` に `provider` と `driveLink` が記録されることを確認。

### 7. 運用・メンテナンス
- [ ] `.env` に各社ログイン情報（ID/PW、トークンパス）を登録（安全な保管を前提に、必要最低限にする）。
- [ ] 各社のサイト構造に変更があった場合、`config/providers.json` とスクレイパーを更新。
- [ ] 失敗した取得リストを日付ごとにまとめ、毎朝確認できるダッシュボードを整備（後続タスク）。

## フォローアップ項目
- 余裕があれば、PDF だけでなくプレーンテキスト（`reports/<date>/plain/<provider>`）を Drive へアップロードし、AI 向け一次処理を省力化。
- 取得済みレポートの重複検知（Hash チェック）を実装し、過去分が Drive に存在する場合はアップロードをスキップ。
- メール通知や Slack 通知など、取得成功/失敗ステータスを監視する仕組みを検討。

---

本計画をベースに、優先度の高いプロバイダ（SMBC日興 → 大和 → みずほ → 三菱UFJモルガン・スタンレー）から着手し、順次リポジトリに反映していく。 каждой task 完了後は `docs/` に経過を記録し、運用チームへの引き継ぎ資料も随時更新する。***

## 進捗メモ（2025-10-22）
- `config/providers.json` を追加し、`smbc-nikko` の MySearch カテゴリIDを整理済み。
- `scripts/providers/smbc.js` を新規実装。Playwright の `storage_state` を用いて MySearch（初期値: 米国経済 / 欧州経済など）を巡回し、`reports/<date>/sources/smbc_nikko.json` を生成する。
  - CLI例: `node scripts/providers/smbc.js --storage-state storage_state.json --date 2025-10-22 --categories us-economy,eu-economy --max-pages 2`
  - `--max-pages` / `--max-items` で負荷を絞り込み可能。ログイン切れの場合はリダイレクト検知でエラーを返す。
- `scripts/collectReports.js` に `--provider` / `--providers` オプションを追加。`--provider smbc-nikko` で上記スクリプトを内部呼び出しし、Nomura 収集と同日に SMBC の JSON を出力できる。
  - Nomura を含む場合は従来通り `overseas_reports.json` を生成し、その日付ディレクトリを SMBC 側でも共有。
- 既存Nomuraフローへの影響は無し（`--provider` 未指定時は従来通り）。
- Playwright用 `storage_state` はブラウザでSMBC日興へログイン後、`await context.storage_state()` で別途作成する必要あり（有効期限に注意）。
- `node scripts/fetchFulltext.js --date 2025-10-22 --categories us-economy,eu-economy --storage-state storage_state.json --drive-upload --debug` を実行。SMBC日興「米国経済」レポート2件のテキスト抽出・PDF保存が完了し、DriveフォルダID `1593sqSQhNgKE7m0noKVdSbJC_XDHtdQ3` に `2025-10-22_米国経済_<サマリ抜粋>.pdf` をアップロード済み（`reports/.meta/2025-10-22/fulltext/us-economy.json` に driveLink 記録）。

### SMBC日興 運用手順メモ（2025-10-23 検証）
- 事前準備: Playwrightの `storage_state.json` をChrome DevTools経由で更新（`scripts/openSmbcForLogin.js` → 手動ログイン → `scripts/saveStorageState.js`）。
- 一覧取得: `node scripts/collectReports.js --providers smbc-nikko --storage-state storage_state.json --date YYYY-MM-DD --smbc-categories us-economy,eu-economy --smbc-max-pages 1 --debug`
  - 成功すると `reports/YYYY-MM-DD/sources/smbc_nikko.json` と `reports/.meta/YYYY-MM-DD/sources/smbc_nikko.json` が生成。
- 本文/PDF: `node scripts/fetchFulltext.js --date YYYY-MM-DD --categories us-economy,eu-economy --storage-state storage_state.json --drive-upload --debug`
  - Driveアップロード先は `.env` の `FULLTEXT_DRIVE_FOLDER_ID`（既定: `1593sqSQhNgKE7m0noKVdSbJC_XDHtdQ3`）直下。標準構成では `YYYY-MM-DD_<レポートタイトル>_<要約抜粋>.pdf` 形式で保存。
  - メタ確認: `reports/.meta/YYYY-MM-DD/fulltext/us-economy.json` に `driveLink` と `driveFileId` が記録されていることを確認。

## 進捗メモ（2025-10-23）
- `node scripts/collectReports.js --providers smbc-nikko --storage-state storage_state.json --date 2025-10-23 --smbc-categories us-economy,eu-economy --smbc-max-pages 1 --debug` を実行し、「米国経済」「欧州経済」各1件を取得（`reports/2025-10-23/sources/smbc_nikko.json`）。
- `node scripts/fetchFulltext.js --date 2025-10-23 --categories us-economy,eu-economy --storage-state storage_state.json --drive-upload --debug` を実行し、該当2件のPDFアップロードを確認（Drive: フォルダID `1593sqSQhNgKE7m0noKVdSbJC_XDHtdQ3` 直下、メタ: `reports/.meta/2025-10-23/fulltext/*.json`）。
- `FULLTEXT_DRIVE_FLAT=1` / `FULLTEXT_DRIVE_USE_DATE_FOLDER=0` を設定し、Drive直下で `YYYY-MM-DD_<レポートタイトル>_<要約抜粋>.pdf` 形式に統一。Nomura/SMBC いずれも同一命名規則・階層で運用する。

### 大和証券 暫定実装メモ（2025-10-23）
- `config/providers.json` に `daiwa` セクションを追加し、対象カテゴリ（大和の視点／大和の経済ビュー／木野内栄治のMarket Tips）と検索キーワード・期待カテゴリ名を登録。
- `scripts/saveStorageState.js` を汎用化。`node scripts/saveStorageState.js --provider daiwa --output storage_state_daiwa.json` で Daiwa Research Portal 用 storage state を生成可能。
- `scripts/providers/daiwa.js` を新規実装。検索ページを開き、カテゴリごとにキーワード検索→日付フィルタ→結果抽出→`reports/<date>/sources/daiwa_securities.json` と `.meta` 側へ保存する暫定フローを追加。
  - 例: `node scripts/providers/daiwa.js --storage-state storage_state_daiwa.json --date 2025-10-23 --categories viewpoint,economic-view,market-tips --max-pages 2 --debug`
  - DOM構造が未検証のため、抽出セレクタは広めに設定。実運用でログを確認しながら最適化を行う。
- `scripts/collectReports.js` から `--provider daiwa` 指定時に上記スクリプトを呼び出すよう連携済み。
- TODO: Daiwa 側の PDF 直リンクやカテゴリIDを特定し、`collectPdfCandidates` への登録およびセレクタの精緻化を行う。

### 大和証券 PDF 取得メモ（2025-10-24）
- `scripts/providers/daiwa.js` の URL 正規化を修正し、相対パス `../../member/...` を `https://drp.daiwa.co.jp/rp-daiwa/...` として保存するように変更。
- `scripts/fulltext/extractors.js` の `collectPdfCandidates` に Daiwa 固有の `report_type=pdf` 変換と `metadata.pdfUrl` 取り込みを追加。リスト画面が保持している `direct/report/<id>/pdf/...` 形式も候補に入るため、HTML抽出後に PDF が添付される。
- `node scripts/fetchFulltext.js --date 2025-10-24 --categories viewpoint,economic-view,market-tips --storage-state storage_state_daiwa.json --no-drive-upload --debug` を実行し、全3カテゴリでPDFバッファ取得と本文抽出が成功したことを確認（Driveは未送信）。
- 今後 Drive へアップロードする際は `--drive-upload` と `.env` の `FULLTEXT_DRIVE_FOLDER_ID` を指定すれば、SMBC/野村と同じ命名規則 (`YYYY-MM-DD_daiwa_securities_<タイトル>.pdf`) で保存可能。
