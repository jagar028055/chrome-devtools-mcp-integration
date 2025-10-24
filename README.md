# Chrome DevTools MCP 統合プロジェクト

このプロジェクトでは、Chrome DevToolsのMCPサーバーを使用したブラウザ自動化・デバッグ機能が統合されています。

## 設定内容

### Claude Code MCP設定
Claude Codeには以下のMCPサーバーが設定されています：
- **chrome-devtools**: Chrome DevToolsプロトコルを使用したブラウザ操作

### プロジェクト設定
`.claude/mcp.json` に以下の設定が含まれています：

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--headless=false",
        "--isolated=true"
      ],
      "description": "Chrome DevTools MCP server for browser automation and debugging"
    }
  }
}
```

## Chrome DevTools MCPとは

Chrome DevTools MCPは、Chromeブラウザの開発ツール（DevTools）にアクセスし、プログラムから操作できるようにするMCPサーバーです。これにより、以下の機能が利用可能になります：

- **ブラウザ自動化**: ページの操作、フォーム入力、クリック等
- **パフォーマンス分析**: パフォーマンストレースの記録と解析
- **ネットワーク監視**: リクエスト・レスポンスの詳細分析
- **スクリーンショット取得**: ページの視覚的な検証
- **デバッグ支援**: コンソールログやエラーの監視

## システム要件

- **Node.js**: 22+ (現在: v24.4.1 ✅)
- **Chrome**: 安定版またはCanary版 (現在: v141.0.7390.55 ✅)
- **インターネット接続**: 初回インストール時に必要

## セットアップ手順

### 1. 依存関係のインストール
```bash
npm install
```

### 2. 設定テストの実行
```bash
npm run test-devtools
```

### 3. Chrome DevTools MCPの起動
```bash
# ヘルプの確認
npx chrome-devtools-mcp --help

# 基本的な起動
npx chrome-devtools-mcp

# カスタム設定での起動
npx chrome-devtools-mcp --headless=false --isolated=true
```

## 利用可能なスクリプト

| コマンド | 説明 |
|----------|------|
| `npm run setup` | 依存関係をインストール |
| `npm run mcp-setup` | Chrome DevTools MCPを直接実行 |
| `npm run test-devtools` | MCP統合テストを実行 |
| `npm run collect` | レポート収集スクリプト |
| `npm run auth` | Google Drive OAuth設定 |
| `npm run test` | 全テストスイートを実行 |
| `npm run ui` | インタラクティブUIを起動 |

## 環境変数設定

`.env`ファイルで以下の設定をカスタマイズできます：

```bash
# Chrome DevTools MCP settings
CHROME_EXECUTABLE_PATH=          # カスタムChromeパス（オプション）
CHROME_USER_DATA_DIR=./tmp/chrome-user-data
CHROME_HEADLESS=false           # ヘッドレスモード
CHROME_DEVTOOLS_PORT=9222       # DevToolsプロトコルポート
CHROME_MCP_TIMEOUT=30000        # タイムアウト（ミリ秒）
CHROME_MCP_SCREENSHOT_QUALITY=90 # スクリーンショット品質
```

## 使用例

### Claude Codeでの利用
Chrome DevTools MCPがClaude Codeに統合されており、以下のような指示で利用できます：

```
例: "https://example.com のパフォーマンスを分析して"
例: "このページのスクリーンショットを撮って"
例: "フォームに自動入力してテストして"
```

### 既存機能との統合
本プロジェクトでは、Chrome DevTools MCPと既存のレポート生成機能が連携できます：
- Playwrightによるブラウザ自動化
- Google Drive APIでの結果保存
- PDF解析との組み合わせ

## レポート取得フロー

以下は Nomura（野村證券）、SMBC日興証券、大和証券のレポートを収集し、Google Drive へ PDF を保存してローカルデータをクリーンアップするまでの手順です。日付は例として `2025-10-24` を使用しています。必要に応じて置き換えてください。

### 1. storage state の発行（初回／認証切れ時）

```bash
# Nomura Research (NomuraNow)
node scripts/saveStorageState.js --provider nomura --output storage_state_nomura.json

# SMBC日興証券
node scripts/saveStorageState.js --provider smbc-nikko --output storage_state_smbc.json

# 大和証券 Daiwa Research Portal
node scripts/saveStorageState.js --provider daiwa --output storage_state_daiwa.json
```

ブラウザが開いたら各社にログインし、完了後ターミナルで Enter を押すと `storage_state_*.json` が保存されます。

### 2. レポート一覧を取得（JSON 出力）

```bash
# Nomura（必要に応じて --debug を付与）
node scripts/collectReports.js \
  --providers nomura \
  --storage-state storage_state_nomura.json \
  --date 2025-10-24 \
  --debug

# SMBC日興証券（カテゴリはコンマ区切り）
node scripts/collectReports.js \
  --providers smbc-nikko \
  --storage-state storage_state_smbc.json \
  --date 2025-10-24 \
  --smbc-categories us-economy,eu-economy \
  --debug

# 大和証券
node scripts/providers/daiwa.js \
  --storage-state storage_state_daiwa.json \
  --date 2025-10-24 \
  --categories viewpoint,economic-view,market-tips \
  --debug
```

### 3. PDF取得とGoogle Driveへのアップロード

```bash
# SMBC日興証券の本文抽出 + Drive アップロード + ローカルクリーンアップ
node scripts/fetchFulltext.js \
  --date 2025-10-24 \
  --categories us-economy,eu-economy \
  --storage-state storage_state_smbc.json \
  --drive-upload \
  --cleanup-local \
  --debug

# 大和証券も同様に実行
node scripts/fetchFulltext.js \
  --date 2025-10-24 \
  --categories viewpoint,economic-view,market-tips \
  --storage-state storage_state_daiwa.json \
  --drive-upload \
  --cleanup-local \
  --debug

# Nomura の fetchFulltext を実装済みの場合は同様に実行します。
```

`--cleanup-local` を指定すると Drive アップロード成功後に `reports/<date>/` 配下の可視 JSON/CSV や `sources/` フォルダが自動削除され、メタ情報（`reports/.meta/<date>/...`）のみが残ります。

### 4. まとめて実行したい場合のサンプル

```bash
# 1日分をまとめて処理するシェルスクリプト例（macOS/Linux）
export TARGET_DATE=2025-10-24

node scripts/collectReports.js --providers nomura \
  --storage-state storage_state_nomura.json --date "$TARGET_DATE"

node scripts/collectReports.js --providers smbc-nikko \
  --storage-state storage_state_smbc.json --date "$TARGET_DATE" \
  --smbc-categories us-economy,eu-economy

node scripts/providers/daiwa.js --storage-state storage_state_daiwa.json \
  --date "$TARGET_DATE" --categories viewpoint,economic-view,market-tips

node scripts/fetchFulltext.js --date "$TARGET_DATE" \
  --categories us-economy,eu-economy \
  --storage-state storage_state_smbc.json --drive-upload --cleanup-local

node scripts/fetchFulltext.js --date "$TARGET_DATE" \
  --categories viewpoint,economic-view,market-tips \
  --storage-state storage_state_daiwa.json --drive-upload --cleanup-local
```

必要に応じて Nomura の本文抽出コマンドも上記スクリプトに追加してください。

## Chrome DevTools PDFフォールバック機能

### 概要
通常のPDFダウンロードが失敗した場合、Chrome DevTools Protocol (CDP) を経由してブラウザ操作でPDFを取得する機能が実装されています。

### 前提条件
1. Chromeをリモートデバッグモードで起動
2. CDP接続用の設定（`.env`で設定済み）

### Chromeのリモートデバッグモード起動

```bash
# macOSの場合
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=./tmp/chrome-user-data
```

起動後、既存のログイン状態が保持されるため、認証が必要なサイトでも利用可能です。

### フォールバック機能の使用

`fetchFulltext` スクリプト実行時に `--enable-cdp-fallback` または `--cdp` フラグを追加：

```bash
# 基本的な使用方法
node scripts/fetchFulltext.js \
  --date 2025-10-04 \
  --category overseas \
  --enable-cdp-fallback

# 短縮形
node scripts/fetchFulltext.js \
  --date 2025-10-04 \
  --category overseas \
  --cdp
```

### PDFサイト設定

`config/pdfSites.json` で対象サイトごとのセレクタを設定：

```json
[
  {
    "domain": "nomuranow.com",
    "name": "NomuraNow",
    "selectors": [
      "a[href*='.pdf']",
      "a[download*='.pdf']",
      "button:has-text('PDF')"
    ]
  }
]
```

### 動作フロー

1. 通常のPDFダウンロードを試行
2. 失敗時、CDP接続が有効かチェック
3. CDP経由でページを開き、設定されたセレクタでPDFリンクをクリック
4. ダウンロードイベントを監視してPDFを保存
5. テキスト抽出後、通常フローと同じく処理

### ログ・モニタリング

CDP経由の操作ログは `logs/devtools/<date>/<entryId>.json` に自動保存：

```json
{
  "url": "https://example.com/report/123",
  "domain": "example.com",
  "timestamp": "2025-10-09T12:34:56.789Z",
  "steps": [
    {"action": "navigate", "url": "...", "timestamp": "..."},
    {"action": "click", "selector": "a[href*='.pdf']", "timestamp": "..."},
    {"action": "download_completed", "path": "tmp/fulltext-cdp/...", "timestamp": "..."}
  ],
  "networkRequests": [...],
  "consoleMessages": [...]
}
```

### トラブルシューティング

**CDP接続エラー**
```bash
# CDP接続確認
curl http://127.0.0.1:9222/json/version

# 正常な場合、ブラウザ情報が返る
```

**PDFダウンロード失敗**
- `config/pdfSites.json` のセレクタを確認
- `--debug` フラグでログを詳細化
- `logs/devtools/` 配下のログを確認

## トラブルシューティング

### よくある問題

**1. Chrome が見つからない場合**
```bash
# macOSの場合
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version
```

**2. MCP サーバーが応答しない場合**
```bash
# 統合テストで診断
npm run test-devtools

# ログファイルでデバッグ
npx chrome-devtools-mcp --logFile /tmp/chrome-mcp.log
```

**3. 権限エラーが発生する場合**
```bash
# 一時的な権限付与（macOS）
sudo xattr -r -d com.apple.quarantine /Applications/Google\ Chrome.app
```

## プロジェクト構成

```
├── .claude/
│   └── mcp.json              # MCP設定ファイル
├── scripts/
│   ├── testChromeDevTools.js # MCP統合テスト
│   ├── collectReports.js     # レポート収集
│   └── setupDriveOAuth.js    # Google認証
├── .env                      # 環境変数設定
├── .env.example             # 環境変数テンプレート
└── package.json             # プロジェクト設定
```








