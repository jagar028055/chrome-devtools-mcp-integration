const fs = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');

let googleModule = null;

function getGoogle() {
  if (!googleModule) {
    ({ google: googleModule } = require('googleapis'));
  }
  return googleModule;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeQueryValue(value) {
  return String(value).replace(/'/g, "\\'");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJsonFile(filePath, label) {
  if (!filePath) return null;
  const exists = await fileExists(filePath);
  if (!exists) {
    throw new Error(`${label || filePath} が存在しません (${filePath})`);
  }
  const content = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label || filePath} のJSON解析に失敗しました: ${error.message}`);
  }
}

async function loadOAuthTokens(tokenPath) {
  if (!tokenPath) return null;
  try {
    const content = await fs.readFile(tokenPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`OAuthトークンの読み込みに失敗しました (${tokenPath}): ${error.message}`);
  }
}

async function saveOAuthTokens(tokenPath, tokens) {
  if (!tokenPath || !tokens) return;
  const dir = path.dirname(tokenPath);
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify(tokens, null, 2);
  await fs.writeFile(tokenPath, payload, { mode: 0o600 });
}

async function createDriveClient(options = {}) {
  const google = getGoogle();
  let credentialsData = options.credentials || null;
  if (!credentialsData && options.credentialsPath) {
    credentialsData = await readJsonFile(options.credentialsPath, 'Google認証情報');
  }

  const oauthConfig = credentialsData?.installed || credentialsData?.web;
  if (oauthConfig) {
    const redirectUri = Array.isArray(oauthConfig.redirect_uris) && oauthConfig.redirect_uris.length > 0
      ? oauthConfig.redirect_uris[0]
      : oauthConfig.redirect_uri;
    if (!redirectUri) {
      throw new Error('OAuthクライアント設定に redirect_uris が含まれていません');
    }
    const tokenPath = options.tokenPath;
    let tokenData = options.token || await loadOAuthTokens(tokenPath);
    if (!tokenData) {
      throw new Error('OAuthトークンが見つかりません。先に `node scripts/setupDriveOAuth.js` を実行してください。');
    }
    const oauth2Client = new google.auth.OAuth2(
      oauthConfig.client_id,
      oauthConfig.client_secret,
      redirectUri
    );
    oauth2Client.setCredentials(tokenData);
    if (tokenPath) {
      oauth2Client.on('tokens', async (newTokens) => {
        if (!newTokens || Object.keys(newTokens).length === 0) return;
        const merged = { ...tokenData, ...newTokens };
        if (newTokens.expiry_date) {
          merged.expiry_date = newTokens.expiry_date;
        }
        await saveOAuthTokens(tokenPath, merged);
        tokenData = merged;
      });
    }
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    return { drive, authClient: oauth2Client };
  }

  const scopes = options.scopes || ['https://www.googleapis.com/auth/drive.file'];
  const authOptions = {
    scopes,
    credentials: credentialsData?.type === 'service_account' ? credentialsData : options.credentials,
    keyFile: credentialsData?.type === 'service_account' ? undefined : options.credentialsPath
  };
  if (options.impersonate) {
    authOptions.clientOptions = { subject: options.impersonate };
  }
  const auth = new google.auth.GoogleAuth(authOptions);
  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });
  return { drive, authClient };
}

async function executeWithRetry(fn, options = {}) {
  const attempts = options.attempts ?? 3;
  const initialDelay = options.initialDelayMs ?? 1000;
  const factor = options.backoffFactor ?? 2;
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      const waitMs = Math.round(initialDelay * (factor ** i));
      if (options.onRetry) {
        options.onRetry({ attempt: i + 1, waitMs, error });
      }
      await delay(waitMs);
    }
  }
  throw lastError;
}

async function ensureFolder(drive, options = {}) {
  const {
    parentId = 'root',
    name,
    driveId,
    supportsAllDrives = true,
    debug = false
  } = options;
  if (!name) {
    throw new Error('ensureFolder には name が必要です');
  }
  const escaped = escapeQueryValue(name);
  const query = [`mimeType = 'application/vnd.google-apps.folder'`, `name = '${escaped}'`, 'trashed = false'];
  if (parentId) {
    query.push(`'${escapeQueryValue(parentId)}' in parents`);
  }
  const listParams = {
    q: query.join(' and '),
    fields: 'files(id, name, parents)',
    pageSize: 5,
    supportsAllDrives,
    includeItemsFromAllDrives: supportsAllDrives
  };
  if (driveId) {
    listParams.corpora = 'drive';
    listParams.driveId = driveId;
  }
  const listResponse = await drive.files.list(listParams);
  if (Array.isArray(listResponse.data.files) && listResponse.data.files.length > 0) {
    return listResponse.data.files[0].id;
  }
  const createResponse = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined
    },
    fields: 'id, name, parents',
    supportsAllDrives
  });
  if (debug) {
    console.log(`[drive] フォルダ作成: ${path.posix.join(parentId || '', name)} => ${createResponse.data.id}`);
  }
  return createResponse.data.id;
}

async function ensureFolderPath(drive, options = {}) {
  const {
    baseFolderId = 'root',
    segments = [],
    driveId,
    supportsAllDrives = true,
    debug = false
  } = options;
  let parentId = baseFolderId || 'root';
  for (const segment of segments) {
    parentId = await ensureFolder(drive, {
      parentId,
      name: segment,
      driveId,
      supportsAllDrives,
      debug
    });
  }
  return parentId;
}

async function applySharing(drive, fileId, options = {}) {
  const tasks = [];
  if (options.shareAnyone) {
    tasks.push(drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      sendNotificationEmail: false,
      requestBody: {
        role: options.shareRole || 'reader',
        type: 'anyone',
        allowFileDiscovery: false
      }
    }).catch((error) => {
      if (options.debug) {
        console.warn(`[drive] anyone共有の設定に失敗しました: ${error.message}`);
      }
      throw error;
    }));
  }
  if (options.shareDomain) {
    tasks.push(drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      sendNotificationEmail: false,
      requestBody: {
        role: options.shareRole || 'reader',
        type: 'domain',
        domain: options.shareDomain,
        allowFileDiscovery: false
      }
    }).catch((error) => {
      if (options.debug) {
        console.warn(`[drive] ドメイン共有の設定に失敗しました: ${error.message}`);
      }
      throw error;
    }));
  }
  if (tasks.length === 0) return [];
  return Promise.all(tasks);
}

async function uploadPdfBuffer(drive, options = {}) {
  const {
    folderId,
    fileName,
    buffer,
    description,
    properties,
    retry,
    debug = false,
    supportsAllDrives = true,
    share
  } = options;
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('アップロード対象のPDFバッファが空です');
  }
  const metadata = {
    name: fileName,
    mimeType: 'application/pdf',
    parents: folderId ? [folderId] : undefined,
    description: description || undefined,
    properties: properties && Object.keys(properties).length > 0 ? properties : undefined
  };
  const media = {
    mimeType: 'application/pdf',
    body: Readable.from(buffer)
  };
  const fields = 'id, name, mimeType, webViewLink, webContentLink, iconLink, parents, createdTime, modifiedTime';
  const response = await executeWithRetry(() => drive.files.create({
    requestBody: metadata,
    media,
    fields,
    supportsAllDrives
  }), {
    attempts: retry?.attempts ?? 3,
    initialDelayMs: retry?.initialDelayMs ?? 1000,
    backoffFactor: retry?.backoffFactor ?? 2,
    onRetry: retry?.onRetry || ((info) => {
      if (debug) {
        console.warn(`[drive] アップロード失敗 (試行${info.attempt}): ${info.error.message}. ${info.waitMs}ms 待機後にリトライ`);
      }
    })
  });

  if (share && (share.shareAnyone || share.shareDomain)) {
    try {
      await applySharing(drive, response.data.id, share);
    } catch (error) {
      if (!share.ignoreShareErrors) {
        throw error;
      }
      if (debug) {
        console.warn(`[drive] 共有設定に失敗しましたが処理を継続します: ${error.message}`);
      }
    }
  }

  return response.data;
}

async function createDriveUploader(options = {}) {
  const { drive } = await createDriveClient({
    credentialsPath: options.credentialsPath,
    credentials: options.credentials,
    tokenPath: options.tokenPath,
    token: options.token,
    scopes: options.scopes,
    impersonate: options.impersonate
  });
  const supportsAllDrives = options.supportsAllDrives !== false;
  const driveId = options.driveId;
  let targetFolderId = options.baseFolderId || 'root';
  if (!options.baseFolderId && !options.allowRootUpload) {
    throw new Error('Driveアップロードには baseFolderId (もしくは allowRootUpload) の指定が必要です');
  }
  if (Array.isArray(options.additionalFolders) && options.additionalFolders.length > 0) {
    targetFolderId = await ensureFolderPath(drive, {
      baseFolderId: targetFolderId,
      segments: options.additionalFolders,
      driveId,
      supportsAllDrives,
      debug: options.debug
    });
  }
  if (options.dateFolderName) {
    targetFolderId = await ensureFolder(drive, {
      parentId: targetFolderId,
      name: options.dateFolderName,
      driveId,
      supportsAllDrives,
      debug: options.debug
    });
  }
  const uploadOptions = {
    supportsAllDrives,
    share: {
      shareAnyone: options.shareAnyone,
      shareDomain: options.shareDomain,
      shareRole: options.shareRole || 'reader',
      ignoreShareErrors: options.ignoreShareErrors,
      debug: options.debug
    },
    retry: options.retry,
    debug: options.debug
  };
  return {
    drive,
    folderId: targetFolderId,
    async ensureSubfolder(segments = []) {
      if (!Array.isArray(segments) || segments.length === 0) {
        return targetFolderId;
      }
      return ensureFolderPath(drive, {
        baseFolderId: targetFolderId,
        segments,
        driveId,
        supportsAllDrives,
        debug: options.debug
      });
    },
    async uploadPdf({ buffer, fileName, description, properties, folderId: customFolderId }) {
      const destinationFolderId = customFolderId || targetFolderId;
      return uploadPdfBuffer(drive, {
        folderId: destinationFolderId,
        buffer,
        fileName,
        description,
        properties,
        supportsAllDrives,
        share: uploadOptions.share,
        retry: uploadOptions.retry,
        debug: uploadOptions.debug
      });
    }
  };
}

module.exports = {
  createDriveClient,
  createDriveUploader,
  ensureFolder,
  ensureFolderPath,
  uploadPdfBuffer
};
