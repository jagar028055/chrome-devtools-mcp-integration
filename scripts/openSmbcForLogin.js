#!/usr/bin/env node
/**
 * SMBC日興のログイン画面までPlaywrightで立ち上げるだけのスクリプト。
 * ユーザーは開いたブラウザ上で手動ログインし、別途 storage_state を保存してください。
 */
const { chromium } = require('playwright');

(async () => {
  console.log('Chromium を起動し、SMBC日興のログインページを開きます…');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://researchdirect.smbcnikko.co.jp/login.php', {
    waitUntil: 'domcontentloaded'
  });

  console.log('ログインページを開きました。ブラウザで手動ログインを完了したら、このウィンドウは閉じて構いません。');
  console.log('※ storage_state.json へ保存する場合は、別途 saveStorageState 等のスクリプトを実行してください。');

  await page.waitForTimeout(60 * 60 * 1000); // 最大1時間待機
  await browser.close();
})();

