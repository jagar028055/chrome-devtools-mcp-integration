# CDP HTML フォールバック実装計画（2025-10-20）

## 概要
- 目的: CDP フォールバックで取得したビューア HTML から本文テキストを抽出し、PDF 不在でも `fetchFullText` の成果物処理を完了させる。
- 範囲: `chromeFallback` → `fetchFullText` の制御フロー、HTML → テキスト変換ユーティリティ、成果物出力 (`--write-plain`/Drive) とテスト整備。

## 前提・準備
- `jsdom` を依存関係に追加（`devDependencies`、`npm install --save-dev jsdom`）。型定義が必要な場合は `@types/jsdom` も導入。
- Playwright 実行環境および既存テスト群 (`npm test`) がローカルで通る状態。
- `tmp/fulltext-cdp/<date>/<entryId>.pdf` 形式で HTML が保存される現状の挙動を踏まえて、拡張子を `.html` に変換しても既存ロジックに影響しないことを確認する。

## 実装タスク
1. **レスポンス判定の拡張**
   - `scripts/fulltext/chromeFallback.js:downloadPdfViaCDP` に HTML 判定ロジックを追加。
   - 判定条件: (a) `response.headers()['content-type']` に `pdf` が含まれない、または (b) 先頭数バイトが `<` で始まる。
   - 戻り値に `{ type: 'html', buffer, headers, url }` を設定し、PDF 時は `{ type: 'pdf', buffer, headers, url }` に統一。
   - HTML の保存パスは `tmp/fulltext-cdp/<date>/<entryId>.html` とし、既存の `.pdf` 出力は PDF 判定時のみに限定。

2. **フォールバック制御フローの分岐**
   - `scripts/fulltext/extractors.js` または `scripts/fulltext/fetchFullText.js`（実際のフォールバック制御点）で `type` に応じた処理分岐を追加。
   - `type === 'html'` の場合は `pdfParse` をスキップし、新規ユーティリティへ委譲。
   - エラーハンドリング: HTML テキスト抽出が失敗したら再試行せずに当該エントリを失敗扱いでログ出力。PDF フローは既存通り。
   - `publication/<id>.file` 形式の URL を候補に加え、HTTP 経由での PDF 取得を HTML 成功時にも試行して `buffer` を添付する。

3. **HTML → テキスト変換ユーティリティ実装**
   - `scripts/fulltext/htmlToText.js` を新規作成。
   - 主要処理:
     - HTML をファイル保存（`writeFile`）しつつ `jsdom` でパース。
     - DOM 操作で `.collapsible` を展開（`classList.add('expanded')` / `style.display = 'block'`）し、`[hidden]` や `aria-expanded` を明示的に解除。
     - 抽出対象を優先順（`article.front-page` → `.theme-container` → `.disclosure` → フォールバックで `main` 全体）で走査し、空文字の場合は次候補へ進む。
     - `innerText` 取得後に脚注の重複番号、連続改行、先頭末尾のホワイトスペースを整形。
     - タイトル、発行日、著者などメタ情報が DOM 上にあれば同時に抽出し、`{ text, meta, sourcePath }` を返却。

4. **成果物処理の更新**
   - `fetchFullText` の戻り値を `{ buffer?, text?, meta?, type }` に整理し、`result.text` が存在する場合は `--write-plain` や Drive アップロードへ渡せるようにする。
   - `scripts/fulltext/output.js` で `result.text` を優先し、`buffer` が無いケースでも `.txt` 出力が行われるよう改修。
   - Drive 連携 (`scripts/fulltext/drive.js`) では HTML テキスト由来のファイルに関して `buffer` が無い場合でもアップロードをスキップしないよう分岐を追加（必要に応じて HTML 原本を Drive 保存するオプションも検討）。
   - Google Drive 上の保存ディレクトリを `ResearchReports/<date>/<provider>/pdf` に統一し、証券会社は URL ドメインから派生したスラッグで自動作成する。

5. **ログおよびモニタリング**
   - HTML フォールバックが発動した際に `result.type === 'html'` をログへ明示（`logs/devtools/...` にも記録）。
   - エラー発生時は HTML 保存パス、レスポンス URL、HTTP ステータスをまとめて出力して調査容易性を確保。

6. **テスト整備**
   - `testCdpFallback.js` に HTML レスポンスをモックし、`type: 'html'` が返却されることを確認。
   - `testFulltextPlain.js` に HTML フィクスチャを追加し、`htmlToText` を経由した `.txt` 出力まで検証。
   - 新規 `htmlToText.test.js`（または既存テストファイルへ追加）で DOM フィクスチャを用いた単体テストを実装。
   - 可能であれば実際の HTML ビューアダンプを縮小してフィクスチャ化し、脚注展開・改行整形の回帰を防止。

7. **ドキュメント更新・オペレーション**
   - `docs/pdf_retrieval_findings.md` に HTML フォールバック実装完了の更新を追記。
   - README / 社内 Wiki に HTML フローが追加された際の依存パッケージ (`jsdom`) と `--write-plain` の出力例を記載。
   - 運用手順書に CDP HTML 保存場所、ログ参照方法、失敗時の調査ポイントを補足。

## スケジュール目安
- 実装（タスク1〜4）: 2〜3 日
- テスト整備（タスク6）: 1 日
- ドキュメント更新・レビュー対応: 0.5 日
- 合計: 約 4.5 日（レビュー待ち除く）

## リスクと対応策
- **HTML 構造変化**: ビューア DOM 変更で抽出失敗リスク。→ セレクタ群を設定化し、抽出失敗時のログ強化。
- **テキスト整形の品質**: 脚注や表が崩れる可能性。→ 実サンプルを複数フィクスチャ化し、整形ルールをテストでカバー。
- **依存追加によるビルド影響**: `jsdom` が環境依存エラーを起こす可能性。→ CI での互換確認、必要に応じてバージョン固定。

## 完了条件
- `fetchFullText` が HTML ビューア入力でも本文 `.txt` を生成し、`npm test`（追加テスト含む）が成功。
- HTML フォールバック発動時に `pdf-parse` エラーが発生しない。
- ドキュメントに運用手順とテキスト化フローが明記されている。
