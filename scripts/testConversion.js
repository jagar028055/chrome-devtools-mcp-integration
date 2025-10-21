#!/usr/bin/env node
const path = require('path');
const fs = require('fs/promises');
const assert = require('assert');
const { writeRegionOutputs, convertToCSV, normalizeEntry } = require('./reportUtils');

async function run() {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'sample_reports.json');
  const sample = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const outDir = path.join(__dirname, '..', 'tmp', 'test-output');
  await fs.rm(outDir, { recursive: true, force: true });
  const { directory, combinedCount } = await writeRegionOutputs(sample, {
    outputDir: outDir,
    runDate: '2025-10-03',
    referenceDate: new Date('2025-10-03T09:00:00Z')
  });
  assert.strictEqual(combinedCount, 5, '期待するエントリ件数と一致しません');
  const jsonPath = path.join(directory, 'overseas_reports.json');
  const csvPath = path.join(directory, 'overseas_reports.csv');
  const jsonStat = await fs.stat(jsonPath);
  const csvStat = await fs.stat(csvPath);
  assert(jsonStat.size > 0, 'JSONが空です');
  assert(csvStat.size > 0, 'CSVが空です');
  const csvContent = await fs.readFile(csvPath, 'utf8');
  assert(/米国：2025年9月FOMC会合/.test(csvContent), 'CSVにFOMCレポートが含まれていません');
  assert(/2025-09-18/.test(csvContent), 'ISO日付が欠落しています');
  console.log('✅ 変換テスト成功');
  console.log(`   出力ディレクトリ: ${directory}`);
  console.log('   例:');
  console.log(csvContent.split('\n').slice(0, 3).join('\n'));
}

run().catch((error) => {
  console.error('❌ テスト失敗:', error);
  process.exitCode = 1;
});
