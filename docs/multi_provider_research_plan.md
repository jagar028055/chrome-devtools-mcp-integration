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
- [ ] `scripts/providers/` ディレクトリを作成し、各社ごとの取得スクリプトを分離。
- [ ] `config/providers.json` を追加し、各社の設定（ベースURL、ログイン方法、カテゴリの正規化ルール）を定義。
- [ ] 取得結果を標準フォーマットに変換するヘルパー（ID、タイトル、カテゴリ、日付、URL、providerSlug を揃える）。

### 1. SMBC日興証券
- [ ] ログイン状態（storage_state もしくは OAuth）を確認。
- [ ] レポート一覧ページの構造調査（HTML/CMS/API）。
- [ ] 主要カテゴリ（例: 為替、株式、マクロ）を抽出するセレクタ・エンドポイントを特定。
- [ ] `scripts/providers/smbc.js` を実装し、日付フィルタとカテゴリ分けを行い `reports/<date>/sources/smbc_nikko.json` を出力。
- [ ] PDF 取得方法（`?format=pdf` / `.pdf` / ビューアHTML）を確認し、`collectPdfCandidates` にプロバイダ特有のパターンを追加。
- [ ] `deriveProviderSlug` に `smbc-nikko` を登録（既存 `PROVIDER_RULES` へ）。

### 2. 大和証券
- [ ] 会員ページの認証方式を確認（ID/PW、証券系シングルサインオンなど）。
- [ ] レポート一覧のカテゴリ構成を調査し、スクレイピング／APIの可否を確認。
- [ ] `scripts/providers/daiwa.js` を実装し、`reports/<date>/sources/daiwa.json` を生成。
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
- [ ] `collectReports.js` を拡張し、各プロバイダスクリプトを順番に呼び出すオプション `--provider` を追加（デフォルト: 全社）。
- [ ] `loadSources` をプロバイダ別 JSON に対応させ、`provider` フィールドを保持。
- [ ] `fetchFulltext` の `driveFileName` を `YYYY-MM-DD_<provider>_<title>.pdf` に統一。
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
