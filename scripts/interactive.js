#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const prompts = require('prompts');
const Table = require('cli-table3');

function dateToString(date) {
  if (!date) return new Date().toISOString().slice(0, 10);
  if (date instanceof Date && !isNaN(date)) {
    return date.toISOString().slice(0, 10);
  }
  return String(date);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const responses = await prompts([
    {
      type: 'select',
      name: 'mode',
      message: '実行モードを選択してください',
      choices: [
        { title: '実データ収集 (Playwright使用)', value: 'live' },
        { title: 'サンプルデータで試す', value: 'sample' }
      ]
    },
    {
      type: (prev) => (prev === 'live' ? 'text' : null),
      name: 'storageState',
      message: 'storage_state.json のパス',
      initial: 'storage_state.json',
      validate: (value) => value ? true : '必須項目です'
    },
    {
      type: 'text',
      name: 'runDate',
      message: '保存日付 (YYYY-MM-DD、未入力で本日)',
      initial: today,
      validate: (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) ? true : 'YYYY-MM-DD形式で入力してください'
    },
    {
      type: 'toggle',
      name: 'useFilter',
      message: 'タイトル/著者のキーフィルターを使用しますか？',
      initial: true,
      active: 'はい',
      inactive: 'いいえ'
    },
    {
      type: 'text',
      name: 'fromDate',
      message: '取得開始日 (YYYY-MM-DD、省略可)',
      initial: '',
      validate: (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) ? true : 'YYYY-MM-DD形式で入力してください'
    },
    {
      type: 'text',
      name: 'toDate',
      message: '取得終了日 (YYYY-MM-DD、省略可)',
      initial: '',
      validate: (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) ? true : 'YYYY-MM-DD形式で入力してください'
    }
  ]);

  if (!responses.mode) {
    console.log('キャンセルしました。');
    return;
  }

  const args = [];
  if (responses.mode === 'sample') {
    args.push('--from', path.join('fixtures', 'sample_reports.json'));
  } else {
    args.push('--storage-state', responses.storageState);
  }

  const runDate = responses.runDate || today;
  args.push('--date', runDate);

  if (!responses.useFilter) {
    args.push('--no-filter');
  }
  if (responses.fromDate) {
    args.push('--from-date', responses.fromDate);
  }
  if (responses.toDate) {
    args.push('--to-date', responses.toDate);
  }

  const child = spawnSync('node', [path.join('scripts', 'collectReports.js'), ...args], {
    stdio: 'inherit'
  });

  if (child.status !== 0) {
    console.error('収集処理が失敗しました。ログを確認してください。');
    return;
  }

  const outputDir = path.join('reports', runDate);
  const jsonPath = path.join(outputDir, 'overseas_reports.json');
  if (!fs.existsSync(jsonPath)) {
    console.log(`出力ファイルが見つかりません: ${jsonPath}`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const table = new Table({
    head: ['地域', 'タイトル', '日付', '著者'],
    colWidths: [18, 60, 12, 40]
  });
  let total = 0;
  for (const payload of Object.values(data)) {
    if (!payload || !payload.items) continue;
    for (const item of payload.items) {
      const authors = Array.isArray(item.analysts) ? item.analysts.join(', ') : item.analysts;
      table.push([
        payload.label || '',
        item.title || '',
        item.date || item.dateISO || '',
        authors || ''
      ]);
      total += 1;
    }
  }
  console.log('\n=== 取得結果プレビュー ===');
  if (total === 0) {
    console.log('条件に一致するレポートがありません。');
  } else {
    console.log(table.toString());
  }
  console.log(`保存先: ${outputDir}`);
}

main().catch((error) => {
  console.error('エラー:', error);
  process.exitCode = 1;
});
