#!/usr/bin/env node
/**
 * storage_state.json を生成するユーティリティ。
 * 1. --provider で対象証券を指定（既定: smbc-nikko）。
 * 2. ブラウザが開いたら ID/PW などでログイン。
 * 3. ログイン完了後にターミナルへ戻り Enter を押すと storage state が保存されます。
 */
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const PROVIDERS = {
  'smbc-nikko': {
    key: 'smbc-nikko',
    label: 'SMBC日興証券',
    loginUrl: 'https://researchdirect.smbcnikko.co.jp/login.php',
    instructions: [
      'SMBC日興証券のログインページを開きました。',
      'ID/PWで認証し、ダッシュボードが表示されるまで完了させてください。'
    ]
  },
  daiwa: {
    key: 'daiwa',
    label: '大和証券',
    loginUrl: 'https://drp.daiwa.co.jp/rp-daiwa/common/login/userLogin.do?orgurl=/rp-daiwa/member/equity/index.do?',
    instructions: [
      '大和証券 Daiwa Research Portal のログインページを開きました。',
      'ワンタイムパスワード不要・ID/PW認証なので、通常のログイン手順を実施してください。',
      'ログイン後にリサーチポータルのトップ（equity/index.do）が表示されていることを確認してください。'
    ]
  },
  nomura: {
    key: 'nomura',
    label: '野村證券（Nomura Research）',
    loginUrl: 'https://www.nomuranow.com/research/',
    instructions: [
      'Nomura Research（NomuraNow）のログインページを開きました。',
      '登録済みのメールアドレスとパスワードでログインしてください。',
      'ログイン後に Research ポータルのホーム画面が表示されることを確認してください。'
    ]
  }
};

function parseArgs(argv) {
  const args = {
    provider: 'smbc-nikko',
    output: 'storage_state.json',
    headless: false,
    slowMo: 0,
    timeout: 60000
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--provider' || arg === '-p') && argv[i + 1]) {
      args.provider = argv[++i];
    } else if ((arg === '--output' || arg === '-o' || arg === '--storage-state') && argv[i + 1]) {
      args.output = argv[++i];
    } else if (arg === '--headless=true') {
      args.headless = true;
    } else if (arg === '--headless=false') {
      args.headless = false;
    } else if (arg === '--slowmo' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) {
        args.slowMo = value;
      }
    } else if (arg === '--timeout' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 5000) {
        args.timeout = value;
      }
    }
  }
  return args;
}

function promptEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  const args = parseArgs(process.argv);
  const providerKey = String(args.provider || '').toLowerCase();
  const provider = PROVIDERS[providerKey];
  if (!provider) {
    console.error(`不明な --provider が指定されました: ${args.provider}`);
    console.error(`利用可能: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const outputPath = path.resolve(args.output);
  const browser = await chromium.launch({ headless: args.headless, slowMo: args.slowMo });
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(provider.loginUrl, {
      waitUntil: 'networkidle',
      timeout: args.timeout
    }).catch((error) => {
      console.warn(`⚠️ ログインページへの遷移でタイムアウトまたはエラーが発生しました: ${error.message}`);
    });

    console.log(`ブラウザを起動しました: ${provider.label}`);
    provider.instructions.forEach((line) => console.log(` - ${line}`));
    console.log('');
    console.log('ログイン完了後にこのターミナルへ戻り Enter を押してください。');

    await promptEnter('準備ができたら Enter ▶ ');

    await context.storageState({ path: outputPath });
    console.log(`✅ storage state を保存しました: ${outputPath}`);
  } catch (error) {
    console.error(`❌ 保存処理でエラーが発生しました: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
})();
