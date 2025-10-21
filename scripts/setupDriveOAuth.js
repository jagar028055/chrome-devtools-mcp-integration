#!/usr/bin/env node
const path = require('path');
const fs = require('fs/promises');
const { google } = require('googleapis');
const prompts = require('prompts');
const { loadEnv } = require('./config/env');
const { getFulltextEnv } = require('./config/fulltext');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets'
];

async function loadOAuthClient(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    throw new Error(`OAuthクライアントJSONの解析に失敗しました: ${error.message}`);
  }
  const config = payload.installed || payload.web;
  if (!config) {
    throw new Error('OAuthクライアントJSONに installed/web 設定が見つかりません');
  }
  if (!Array.isArray(config.redirect_uris) || config.redirect_uris.length === 0) {
    throw new Error('OAuthクライアントに redirect_uris が設定されていません');
  }
  return config;
}

async function saveToken(tokenPath, tokens) {
  const dir = path.dirname(tokenPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function main() {
  loadEnv();
  const env = getFulltextEnv();
  if (!env.googleCredentials) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS が未設定です。まず .env を更新してください。');
  }
  const clientConfig = await loadOAuthClient(env.googleCredentials);
  const redirectUri = clientConfig.redirect_uris[0];
  const oAuth2Client = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    redirectUri
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('================ Google OAuth 認証 =================');
  console.log('1. 次のURLをブラウザで開き、Googleアカウントで認証してください。');
  console.log(authUrl);
  console.log('\n2. 表示された認証コードをこのターミナルに貼り付けてください。\n');

  const response = await prompts({
    type: 'text',
    name: 'code',
    message: '認証コード'
  }, {
    onCancel: () => {
      throw new Error('ユーザーによって認証がキャンセルされました');
    }
  });

  if (!response.code || !response.code.trim()) {
    throw new Error('認証コードが空です');
  }

  const { tokens } = await oAuth2Client.getToken(response.code.trim());
  oAuth2Client.setCredentials(tokens);

  const tokenPath = env.tokenPath || path.resolve(process.cwd(), 'secure/credentials/token.json');
  await saveToken(tokenPath, tokens);

  console.log('✅ OAuthトークンを保存しました:', tokenPath);
  console.log('   次回以降は再認証なしでスクリプトを実行できます。');
}

main().catch((error) => {
  console.error('❌ 認証フローでエラーが発生しました:', error.message);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});

