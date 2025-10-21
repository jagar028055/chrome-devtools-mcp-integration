#!/usr/bin/env node
const path = require('path');
const fs = require('fs/promises');
const assert = require('assert');
const { writeCategoryOutputs } = require('./fulltext/output');
const { extractTextFromHtml } = require('./fulltext/htmlToText');

async function run() {
  const outDir = path.join(__dirname, '..', 'tmp', 'fulltext-plain-test');
  await fs.rm(outDir, { recursive: true, force: true });
  const htmlFixturePath = path.join(__dirname, '..', 'fixtures', 'html_viewer_sample.html');
  const htmlFixture = await fs.readFile(htmlFixturePath, 'utf8');
  const htmlExtract = extractTextFromHtml(htmlFixture, { minLength: 0 });
  assert.ok(htmlExtract.text.includes('ドル円'), 'HTML抽出で本文が取得できるべき');
  assert.ok(htmlExtract.text.includes('脚注1'), '折り畳み要素のテキストが含まれるべき');

  const categoryResults = new Map();
  categoryResults.set('Equity', [
    {
      id: 'sample-1',
      category: 'Equity',
      title: 'Sample Plain Title',
      text: 'Sample plain text content',
      pdfPath: 'tmp/fulltext-pdf/2025-10-04/sample-1.pdf'
    },
    {
      id: 'sample-2',
      category: 'Equity',
      text: null
    },
    {
      id: 'html-1',
      category: 'Equity',
      title: '為替モーニングコメント',
      text: htmlExtract.text
    }
  ]);

  await writeCategoryOutputs(outDir, categoryResults, { writePlain: true });

  const plainDir = path.join(outDir, 'fulltext', 'plain');
  const files = await fs.readdir(plainDir);
  assert.ok(files.includes('Sample Plain Title.txt'), 'タイトルベースのファイル名が存在するべき');
  assert.ok(files.includes('sample-2.txt'), 'IDベースのファイル名が存在するべき');
  assert.ok(files.some((name) => name.startsWith('為替モーニングコメント')), 'HTML抽出結果のファイルが存在するべき');
  const plain1 = await fs.readFile(path.join(plainDir, 'Sample Plain Title.txt'), 'utf8');
  const plain2 = await fs.readFile(path.join(plainDir, 'sample-2.txt'), 'utf8');
  const htmlPlainName = files.find((name) => name.startsWith('為替モーニングコメント'));
  const htmlPlain = await fs.readFile(path.join(plainDir, htmlPlainName), 'utf8');
  assert.strictEqual(plain1, 'Sample plain text content', 'Sample Plain Title のプレーンテキストが一致しません');
  assert.strictEqual(plain2, '', 'sample-2のプレーンテキストは空文字のはずです');
  assert.ok(htmlPlain.includes('ドル円'), 'HTMLプレーンテキストに本文が含まれるべき');
  assert.ok(htmlPlain.includes('脚注1'), 'HTMLプレーンテキストに脚注が含まれるべき');

  const indexJson = JSON.parse(await fs.readFile(path.join(outDir, 'fulltext', 'index.json'), 'utf8'));
  assert.ok(indexJson.Equity, 'index.json にEquityが存在しません');
  const categoryJson = JSON.parse(await fs.readFile(path.join(outDir, 'fulltext', 'Equity.json'), 'utf8'));
  assert.strictEqual(categoryJson.total, 3, 'Equityカテゴリの件数が期待値と異なります');
  assert.strictEqual(categoryJson.items[0].pdfPath, 'tmp/fulltext-pdf/2025-10-04/sample-1.pdf', 'pdfPath が保持されていません');

  console.log('✅ writeCategoryOutputs --write-plain テスト成功');
}

run().catch((error) => {
  console.error('❌ テスト失敗:', error);
  process.exitCode = 1;
});
